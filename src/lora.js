import { saveSettingsDebounced } from '../../../../../script.js';
import { getSettings, getActiveProfile, saveProfiles } from './profiles.js';
import { classifySceneWithLLM } from './lora_agent.js';

/**
 * Resolves the active LoRA profile's entries array for the given profile.
 * Falls back to profile.loras.entries for legacy data.
 *
 * @param {object} profile - The active profile object.
 * @returns {Array} The entries array (by reference).
 */
function getLoraEntries(profile) {
    const settings = getSettings();
    if (profile.activeLoraProfileId && settings.loraProfiles && settings.loraProfiles[profile.activeLoraProfileId]) {
        const loraProfile = settings.loraProfiles[profile.activeLoraProfileId];
        if (!loraProfile.entries) loraProfile.entries = [];
        return loraProfile.entries;
    }
    // Legacy fallback
    if (!profile.loras) profile.loras = { entries: [], depth: 5 };
    if (!profile.loras.entries) profile.loras.entries = [];
    return profile.loras.entries;
}

/**
 * Adds a new empty LoRA entry to the active LoRA profile's entries array.
 * @param {string} profileId - The profile ID to add the entry to.
 * @returns {object} The newly created LoRA entry.
 */
export function addLoraEntry(profileId) {
    const settings = getSettings();
    const profile = settings.profiles[profileId];

    if (!profile) {
        console.log('[IGS] Profile not found:', profileId);
        return null;
    }

    const entries = getLoraEntries(profile);

    const entry = {
        id: crypto.randomUUID(),
        enabled: true,
        triggers: [],
        description: '',
        prompt: '',
        caseSensitive: false,
    };

    entries.push(entry);
    saveProfiles();
    saveSettingsDebounced();
    console.log('[IGS] Added LoRA entry:', entry.id, 'to profile:', profileId);

    return entry;
}

/**
 * Removes a LoRA entry from the active LoRA profile.
 * @param {string} profileId - The profile ID containing the entry.
 * @param {string} entryId - The ID of the entry to delete.
 */
export function deleteLoraEntry(profileId, entryId) {
    const settings = getSettings();
    const profile = settings.profiles[profileId];

    if (!profile) {
        console.log('[IGS] Profile not found for deletion:', profileId);
        return;
    }

    const entries = getLoraEntries(profile);
    const index = entries.findIndex(e => e.id === entryId);
    if (index === -1) {
        console.log('[IGS] LoRA entry not found:', entryId);
        return;
    }

    entries.splice(index, 1);
    saveProfiles();
    saveSettingsDebounced();
    console.log('[IGS] Deleted LoRA entry:', entryId, 'from profile:', profileId);
}

/**
 * Updates a LoRA entry with partial data.
 * @param {string} profileId - The profile ID containing the entry.
 * @param {string} entryId - The ID of the entry to update.
 * @param {object} data - Partial object with fields to update (e.g. { triggers: ['elf'], prompt: 'elf ears' }).
 */
export function updateLoraEntry(profileId, entryId, data) {
    const settings = getSettings();
    const profile = settings.profiles[profileId];

    if (!profile) {
        console.log('[IGS] Profile not found for update:', profileId);
        return;
    }

    const entries = getLoraEntries(profile);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) {
        console.log('[IGS] LoRA entry not found for update:', entryId);
        return;
    }

    Object.assign(entry, data);
    saveProfiles();
    saveSettingsDebounced();
    console.log('[IGS] Updated LoRA entry:', entryId, 'with:', Object.keys(data).join(', '));
}

/**
 * Toggles the enabled state of a LoRA entry.
 * @param {string} profileId - The profile ID containing the entry.
 * @param {string} entryId - The ID of the entry to toggle.
 */
export function toggleLoraEntry(profileId, entryId) {
    const settings = getSettings();
    const profile = settings.profiles[profileId];

    if (!profile) {
        console.log('[IGS] Profile not found for toggle:', profileId);
        return;
    }

    const entries = getLoraEntries(profile);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) {
        console.log('[IGS] LoRA entry not found for toggle:', entryId);
        return;
    }

    entry.enabled = !entry.enabled;
    saveProfiles();
    saveSettingsDebounced();
    console.log('[IGS] Toggled LoRA entry:', entryId, 'enabled:', entry.enabled);
}

/**
 * Scans messages for LoRA trigger matches.
 * @param {object} profile - The profile object containing loras.entries.
 * @param {Array} messages - Array of message objects (already sliced to correct depth) with `mes` field.
 * @param {boolean} [allowAiClassification=false] - When true, allows the LLM classification agent to run if AI detection is enabled. Should only be true during actual image generation.
 * @returns {Array} Array of matched LoRA entry objects (deduplicated).
 */
export async function scanForTriggers(profile, messages, allowAiClassification = false) {
    if (!profile || !messages || messages.length === 0) {
        return [];
    }

    const entries = getLoraEntries(profile);
    if (!entries || entries.length === 0) {
        return [];
    }

    // If AI detection is enabled AND we're in an image generation context, use LLM classification
    if (allowAiClassification && profile.aiLora?.enabled) {
        const lastMessage = messages[messages.length - 1]?.mes || '';
        if (!lastMessage) return [];
        
        const matchedIds = await classifySceneWithLLM(profile, lastMessage, entries);
        return entries.filter(e => matchedIds.includes(e.id));
    }

    const matchedEntries = [];
    const matchedIds = new Set();

    for (const entry of entries) {
        if (!entry.enabled) {
            continue;
        }

        if (!entry.triggers || entry.triggers.length === 0) {
            continue;
        }

        if (matchedIds.has(entry.id)) {
            continue;
        }

        let entryMatched = false;

        for (const trigger of entry.triggers) {
            if (!trigger || trigger.trim() === '') {
                continue;
            }

            for (const message of messages) {
                if (!message || !message.mes) {
                    continue;
                }

                let messageText = message.mes;
                let triggerText = trigger;

                if (!entry.caseSensitive) {
                    messageText = messageText.toLowerCase();
                    triggerText = triggerText.toLowerCase();
                }

                if (messageText.includes(triggerText)) {
                    entryMatched = true;
                    break;
                }
            }

            if (entryMatched) {
                break;
            }
        }

        if (entryMatched) {
            matchedIds.add(entry.id);
            matchedEntries.push(entry);
        }
    }

    console.log('[IGS] Trigger scan found', matchedEntries.length, 'matching LoRA entries');
    return matchedEntries;
}

/**
 * Compiles matched LoRA entries into a single comma-separated prompt string.
 * @param {Array} matchedEntries - Array of matched LoRA entry objects.
 * @returns {string} Comma-separated string of all prompt values, or empty string if none.
 */
export function compileLoraPrompts(matchedEntries) {
    if (!matchedEntries || matchedEntries.length === 0) {
        return '';
    }

    const prompts = matchedEntries
        .map(entry => entry.prompt)
        .filter(prompt => prompt && prompt.trim() !== '');

    return prompts.join(', ');
}

/**
 * Compiles matched LoRA entries into a formatted description string for LLM injection.
 * @param {Array} matchedEntries - Array of matched LoRA entry objects.
 * @returns {string} Formatted description string, or empty string if no matches or no descriptions.
 */
export function compileLoraDescriptions(matchedEntries) {
    if (!matchedEntries || matchedEntries.length === 0) {
        return '';
    }

    const lines = matchedEntries
        .filter(entry => entry.description && entry.description.trim() !== '')
        .map(entry => {
            const triggers = entry.triggers.join(', ');
            return `- ${entry.description} (triggers: ${triggers})`;
        });

    if (lines.length === 0) {
        return '';
    }

    return `[Active LoRA context]\n${lines.join('\n')}`;
}
