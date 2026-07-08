import { getContext } from '../../../../extensions.js';

// In-memory cache for LoRA classification results
const classificationCache = new Map();

/**
 * Generates a consistent cache key for message text and active LoRA profile.
 * @param {string} messageText - The message to analyze.
 * @param {string} profileId - The active LoRA profile ID.
 * @returns {string} The cache key.
 */
function getCacheKey(messageText, profileId) {
    const cleanText = messageText.trim().toLowerCase();
    return `${profileId}:${cleanText}`;
}

/**
 * Robust helper to extract and parse a JSON array from LLM response text,
 * even when wrapped in conversational filler or markdown code blocks.
 * @param {string} text - Raw LLM output.
 * @returns {Array<string>} Array of matched LoRA entry IDs.
 */
function parseJsonArraySafely(text) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    const cleanText = text.trim();

    // 1. Try standard JSON.parse directly
    try {
        const parsed = JSON.parse(cleanText);
        if (Array.isArray(parsed)) {
            return parsed.map(String);
        }
    } catch (e) {}

    // 2. Extract contents inside markdown code blocks (e.g. ```json [...] ``` or ``` [...] ```)
    const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch && codeBlockMatch[1]) {
        try {
            const parsed = JSON.parse(codeBlockMatch[1].trim());
            if (Array.isArray(parsed)) {
                return parsed.map(String);
            }
        } catch (e) {}
    }

    // 3. Fallback: Find the first occurrence of '[' and matching ']' and attempt to parse it
    const arrayMatch = cleanText.match(/\[\s*[\s\S]*?\s*\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) {
                return parsed.map(String);
            }
        } catch (e) {}
    }

    console.warn('[IGS] Failed to parse LLM response as a valid JSON array of strings:', cleanText);
    return [];
}

/** Default system prompt template for the LoRA detection agent. */
const DEFAULT_AGENT_PROMPT = `You are a JSON classification tool. You are NOT a chatbot. You MUST NOT roleplay, narrate, generate stories, or produce any output other than a raw JSON array. Any non-JSON output is a critical failure.

TASK: Read the scene text below and determine which LoRAs from the list are visually present, described, or strongly implied.

AVAILABLE LORAS (format — "id": "description"):
{{lora_list}}

RULES:
- Select between {{min}} and {{max}} LoRAs whose descriptions match elements in the scene.
- If nothing matches, return exactly: []
- Only select LoRAs clearly relevant to the scene content.
- Do NOT add LoRAs that are only vaguely related.

OUTPUT: Respond with ONLY a raw JSON array of ID strings. No markdown, no code fences, no explanation, no conversation.
Valid examples: ["id_1","id_2"] or []`;

/**
 * Discovers available SillyTavern connection profiles from global state.
 * Adapted from BetterSimTracker's discoverConnectionProfiles.
 * @returns {Array<{id: string, label: string}>} Available connection profile options.
 */
export function discoverConnectionProfiles() {
    const profiles = [];
    const seen = new Set();

    function addProfile(id, label) {
        if (!id || seen.has(id)) return;
        seen.add(id);
        profiles.push({ id, label: label || id });
    }

    function extractFromArray(arr) {
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id ?? item.profileId ?? item.value ?? item.profile ?? '').trim();
            const label = String(item.name ?? item.label ?? item.displayName ?? item.title ?? id).trim();
            if (id) addProfile(id, label);
        }
    }

    // Source 1 (primary): context.extensionSettings.connectionManager.profiles
    try {
        const context = getContext();
        const extSettings = context?.extensionSettings;
        const connManager = extSettings?.connectionManager;
        extractFromArray(connManager?.profiles);

        // Also check chatCompletionSettings
        const cc = context?.chatCompletionSettings;
        if (cc) {
            extractFromArray(cc.profiles);
            extractFromArray(cc.profileList);
            extractFromArray(cc.connections);
        }
    } catch (e) {
        console.warn('[IGS] Error accessing context for connection profiles:', e);
    }

    // Source 2: globalThis fallbacks (for bundled / non-module environments)
    const globalObj = globalThis;
    const globalExt = globalObj.extension_settings;
    const globalConn = globalExt?.connectionManager;
    extractFromArray(globalConn?.profiles);

    extractFromArray(globalObj.chat_completion_profiles);
    extractFromArray(globalObj.chatCompletionProfiles);
    const powerUser = globalObj.power_user;
    if (powerUser) {
        extractFromArray(powerUser.chat_completion_profiles);
        extractFromArray(powerUser.chatCompletionProfiles);
    }

    // Source 3: localStorage fallback
    if (profiles.length === 0) {
        try {
            const keys = [
                'chat_completion_profiles',
                'chatCompletionProfiles',
                'extension-settings:connection-manager'
            ];
            for (const key of keys) {
                const raw = localStorage.getItem(key);
                if (!raw) continue;
                try {
                    const parsed = JSON.parse(raw);
                    // connection-manager stores { profiles: [...], selectedProfile: ... }
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        extractFromArray(parsed.profiles);
                    } else {
                        extractFromArray(parsed);
                    }
                    if (profiles.length > 0) break;
                } catch (e) {}
            }
        } catch (e) {}
    }

    return profiles;
}

/**
 * Semantically classifies the scene in messageText against active LoRA descriptions using SillyTavern's LLM.
 * @param {object} profile - Active profile settings.
 * @param {string} messageText - Message text to classify.
 * @param {Array<object>} entries - List of available LoRA trigger entries.
 * @returns {Promise<Array<string>>} List of matched LoRA entry IDs.
 */
export async function classifySceneWithLLM(profile, messageText, entries) {
    if (!messageText || !entries || entries.length === 0) {
        return [];
    }

    const loraProfileId = profile.activeLoraProfileId || 'default';
    const cacheKey = getCacheKey(messageText, loraProfileId);

    // Check cache first
    if (classificationCache.has(cacheKey)) {
        console.log('[IGS] LLM classification cache hit for message:', messageText.substring(0, 40) + '...');
        return classificationCache.get(cacheKey);
    }

    const context = getContext();
    const generateQuietPrompt = context.generateQuietPrompt;

    if (typeof generateQuietPrompt !== 'function') {
        console.warn('[IGS] generateQuietPrompt is not available in getContext(). Falling back to empty matches.');
        return [];
    }

    // Extract ranges
    const minMatches = typeof profile.aiLora?.minMatches === 'number' ? profile.aiLora.minMatches : 0;
    const maxMatches = typeof profile.aiLora?.maxMatches === 'number' ? profile.aiLora.maxMatches : 3;

    // Build descriptions list of available LoRAs (ignoring entries without descriptions)
    const availableLoras = entries
        .filter(e => e.description && e.description.trim() !== '')
        .map(e => `"${e.id}": "${e.description.trim()}"`)
        .join('\n');

    if (!availableLoras) {
        console.log('[IGS] No LoRA entries have descriptions. Skipping LLM detection.');
        return [];
    }

    // Resolve agent system prompt: user custom prompt or default
    const userPrompt = (profile.aiLora?.prompt || '').trim();
    const promptTemplate = userPrompt || DEFAULT_AGENT_PROMPT;

    // Substitute template placeholders
    const systemPrompt = promptTemplate
        .replace(/\{\{lora_list\}\}/g, availableLoras)
        .replace(/\{\{min\}\}/g, String(minMatches))
        .replace(/\{\{max\}\}/g, String(maxMatches));

    const fullPrompt = `[System instructions]\n${systemPrompt}\n[End System instructions]\n\n[Message to analyze]\n"${messageText}"\n[End Message to analyze]`;

    // Resolve connection profile
    const connectionProfileId = (profile.aiLora?.connectionProfileId || '').trim();

    console.log('[IGS] Triggering background LLM LoRA classification...');
    if (connectionProfileId) {
        console.log('[IGS] Using connection profile:', connectionProfileId);
    }

    try {
        // Build the generation options.
        // noContext: true  → strips chat history, character card, and preset system prompt.
        // skipWIAN: true   → skips World Info and Author's Note injection.
        // This ensures the agent receives ONLY our classification prompt.
        const generationOptions = {
            quietPrompt: fullPrompt,
            skipWIAN: true,
            noContext: true,
            responseLength: 300,
        };

        if (connectionProfileId) {
            generationOptions.connectionProfile = connectionProfileId;
        }

        const rawResponse = await generateQuietPrompt(generationOptions);
        console.log('[IGS] Raw LLM classification response:', rawResponse);

        let matchedIds = parseJsonArraySafely(rawResponse);

        // Enforce maximum selection bounds programmatically
        if (matchedIds.length > maxMatches) {
            console.log(`[IGS] LLM returned ${matchedIds.length} matches, slicing to max limit of ${maxMatches}`);
            matchedIds = matchedIds.slice(0, maxMatches);
        }

        // Cache the result
        classificationCache.set(cacheKey, matchedIds);
        return matchedIds;
    } catch (error) {
        console.error('[IGS] Error running background LLM LoRA classification:', error);
        return [];
    }
}
