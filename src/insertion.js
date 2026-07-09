import { appendMediaToMessage, updateMessageBlock, eventSource, event_types, getRequestHeaders, substituteParams } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { saveBase64AsFile, getCharaFilename, regexFromString } from '../../../../utils.js';
import { getMessageTimeStamp } from '../../../../RossAscends-mods.js';
import { generateImage } from './connection.js';
import { scanForTriggers, compileLoraPrompts, compileLoraDescriptions } from './lora.js';
import { getSettings, getActiveProfile } from './profiles.js';
import { resolveCustomMacro } from './detection.js';

/**
 * Compiles prompt template configurations, active style selections, and LoRA triggers into final generation strings.
 * Used at generation time — scans for LoRA triggers and returns all data needed for persistence.
 *
 * @param {object} profile - The active profile configuration.
 * @param {string} rawPrompt - The raw prompt text from the capture group.
 * @param {number|null} messageIndex - The message index in context.chat (used for LoRA scan positioning).
 * @returns {object} { positive, negative, loraPrompts }
 */
export async function compilePrompts(profile, rawPrompt, messageIndex = null) {
    const context = getContext();
    const chat = context.chat || [];

    // Determine target index for scanning triggers relative to the message
    const idx = (typeof messageIndex === 'number') ? messageIndex : (chat.length - 1);

    // Scan for LoRA triggers in messages leading up to the targeted index
    const loraDepth = (profile.loras && profile.loras.depth) ? profile.loras.depth : 5;
    const scanStart = Math.max(0, idx - loraDepth + 1);
    const recentMessages = chat.slice(scanStart, idx + 1);

    // Append rawPrompt as a virtual message so triggers in the prompt itself are always matched
    if (rawPrompt) {
        recentMessages.push({ mes: rawPrompt });
    }

    const matchedEntries = await scanForTriggers(profile, recentMessages, true);

    // Compile LoRA prompts for SD positive prompt
    const loraPrompts = compileLoraPrompts(matchedEntries);

    // Build the final prompt using the shared helper
    const result = buildFinalPrompt(profile, rawPrompt, loraPrompts);
    result.loraPrompts = loraPrompts;
    return result;
}

/**
 * Compiles prompts using pre-saved LoRA prompt strings (no trigger re-scanning).
 * Used by getters on message properties for swipe regeneration.
 *
 * @param {object} profile - The active profile configuration.
 * @param {string} rawPrompt - The raw prompt text.
 * @param {string} savedLoraPrompts - The LoRA prompts string saved at generation time.
 * @returns {object} { positive, negative }
 */
export function compilePromptsFromSaved(profile, rawPrompt, savedLoraPrompts) {
    return buildFinalPrompt(profile, rawPrompt, savedLoraPrompts || '');
}

/**
 * Shared helper that builds final positive/negative prompt strings from profile settings,
 * style content, and LoRA prompts. Does NOT scan for triggers.
 *
 * @param {object} profile - The active profile configuration.
 * @param {string} rawPrompt - The raw prompt text.
 * @param {string} loraPrompts - Already-resolved LoRA prompt string.
 * @returns {object} { positive, negative }
 */
function buildFinalPrompt(profile, rawPrompt, loraPrompts) {
    // Retrieve active style content
    const settings = getSettings();
    let styleContent = '';
    if (profile.activeStyleName && profile.activeStyleName !== 'Default' && profile.activeStyleProfileId && settings.styleProfiles) {
        const stylesProfile = settings.styleProfiles[profile.activeStyleProfileId];
        const style = stylesProfile?.styles?.find(s => s.name === profile.activeStyleName);
        if (style) {
            styleContent = style.content || '';
        }
    }

    // Build variables mapping
    const promptConstruction = profile.promptConstruction || {};
    const variables = {
        prefix: promptConstruction.prefix || '',
        prompt: rawPrompt || '',
        style: styleContent,
        styles: styleContent, // Alias support
        suffix: promptConstruction.suffix || '',
        loras: loraPrompts || '',
        promptExtra: profile.hub?.promptExtra || '',
        negativeExtra: profile.hub?.negativeExtra || '',
        negativePrefix: promptConstruction.negativePrefix || '',
        negative: '',
        negativeSuffix: promptConstruction.negativeSuffix || ''
    };

    // Helper functions for template interpolation and cleaning
    const interpolateTemplate = (template, vars) => {
        if (!template) return '';
        return template.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (match, key) => {
            return typeof vars[key] !== 'undefined' ? vars[key] : match;
        });
    };

    const cleanPromptString = (str) => {
        if (!str) return '';
        return str
            .replace(/,\s*,/g, ',')
            .replace(/^\s*,\s*/, '')
            .replace(/\s*,\s*$/, '')
            .replace(/\s+/g, ' ')
            .trim();
    };

    // Interpolate and clean positive prompt
    const positiveTemplate = promptConstruction.positiveTemplate || '{prefix}, {prompt}, {promptExtra}, {style}, {loras}, {suffix}';
    const positivePromptRaw = cleanPromptString(interpolateTemplate(positiveTemplate, variables));
    const fullPositivePrompt = substituteParams(positivePromptRaw);

    // Interpolate and clean negative prompt
    const negativeTemplate = promptConstruction.negativeTemplate || '{negativePrefix}, {negative}, {negativeExtra}, {negativeSuffix}';
    const negativePromptRaw = cleanPromptString(interpolateTemplate(negativeTemplate, variables));
    const fullNegativePrompt = substituteParams(negativePromptRaw);

    return {
        positive: fullPositivePrompt,
        negative: fullNegativePrompt
    };
}

/**
 * Defines dynamic getters and setters on a message's extra block to ensure
 * swiping/regenerating uses the current active style.
 *
 * @param {object} message - The SillyTavern ChatMessage object.
 */
export function applyPromptGetters(message) {
    if (!message || !message.extra || !message.extra.raw_prompt) {
        return;
    }

    const desc = Object.getOwnPropertyDescriptor(message.extra, 'title');
    if (desc && desc.get) {
        return; // Already configured
    }

    let rawPromptVal = message.extra.raw_prompt;
    let rawNegativeVal = message.extra.negative_raw || '';
    let savedLoraPrompts = message.extra.lora_prompts || '';
    let mediaArray = message.extra.media || [];

    // Getter helper — uses saved LoRA prompts, only re-evaluates style
    const getCompiled = () => {
        const profile = getActiveProfile();
        if (!profile) return { positive: rawPromptVal, negative: rawNegativeVal };
        return compilePromptsFromSaved(profile, rawPromptVal, savedLoraPrompts);
    };

    // Bind getters on message.extra root properties
    Object.defineProperty(message.extra, 'title', {
        get: function() { return getCompiled().positive; },
        set: function(val) {
            rawPromptVal = val;
            message.extra.raw_prompt = val;
        },
        configurable: true,
        enumerable: true
    });

    Object.defineProperty(message.extra, 'negative', {
        get: function() { return getCompiled().negative; },
        set: function(val) {
            rawNegativeVal = val;
            message.extra.negative_raw = val;
        },
        configurable: true,
        enumerable: true
    });

    // Helper to apply getters to an individual media attachment
    const applyGettersToAttachment = (mediaAttachment) => {
        if (!mediaAttachment || typeof mediaAttachment !== 'object') return;
        const attachmentDesc = Object.getOwnPropertyDescriptor(mediaAttachment, 'title');
        if (attachmentDesc && attachmentDesc.get) return; // Already bound

        delete mediaAttachment.title;
        delete mediaAttachment.negative;

        Object.defineProperty(mediaAttachment, 'title', {
            get: function() { return getCompiled().positive; },
            set: function() { /* Ignore static writes to keep prompt dynamic */ },
            configurable: true,
            enumerable: true
        });

        Object.defineProperty(mediaAttachment, 'negative', {
            get: function() { return getCompiled().negative; },
            set: function() { /* Ignore static writes to keep prompt dynamic */ },
            configurable: true,
            enumerable: true
        });
    };

    // Bind getter on message.extra.media array property itself
    Object.defineProperty(message.extra, 'media', {
        get: function() {
            if (Array.isArray(mediaArray)) {
                mediaArray.forEach(applyGettersToAttachment);
            }
            return mediaArray;
        },
        set: function(val) {
            mediaArray = val;
            if (Array.isArray(mediaArray)) {
                mediaArray.forEach(applyGettersToAttachment);
            }
        },
        configurable: true,
        enumerable: true
    });

    // Apply initially to any existing items in the array
    if (Array.isArray(mediaArray)) {
        mediaArray.forEach(applyGettersToAttachment);
    }
}

/**
 * Main orchestration function for generating and inserting an image into the chat.
 * Called by the detection module when an image generation tag is found.
 *
 * @param {object} profile - The active profile object.
 * @param {string} rawPrompt - The raw prompt extracted from the tag capture group.
 * @param {number} messageIndex - The index of the message containing the tag.
 * @param {string} originalTag - The full original matched tag text for replacement.
 */
export async function processImageGeneration(profile, rawPrompt, messageIndex, originalTag) {
    const context = getContext();

    // Compile templates and resolve styles/loras
    const compiled = await compilePrompts(profile, rawPrompt, messageIndex);
    const fullPositivePrompt = compiled.positive;
    const fullNegativePrompt = compiled.negative;
    const loraPrompts = compiled.loraPrompts || '';

    console.log('[IGS] Compiled positive prompt sent to API:', fullPositivePrompt);
    console.log('[IGS] Compiled negative prompt sent to API:', fullNegativePrompt);

    // Call the image generation API
    const result = await generateImage(profile, fullPositivePrompt, fullNegativePrompt);

    if (!result || !result.data) {
        throw new Error('Image generation returned no data');
    }

    // Save the base64 image to a file and get the URL
    const charaFilename = getCharaFilename() || 'unknown';
    const imageUrl = await saveBase64AsFile(result.data, charaFilename, '', result.format);

    console.log('[IGS] Image saved:', imageUrl);

    // Insert the image based on the configured insert type
    const insertType = profile.settings && profile.settings.insertType ? profile.settings.insertType : 'in_message';

    switch (insertType) {
        case 'in_message':
            insertImageInMessage(messageIndex, imageUrl, fullPositivePrompt, fullNegativePrompt, rawPrompt, loraPrompts);
            break;
        case 'new_message':
            const hideFromLLM = !!(profile.settings && profile.settings.hideFromLLM);
            insertImageAsNewMessage(imageUrl, fullPositivePrompt, fullNegativePrompt, rawPrompt, hideFromLLM, loraPrompts);
            break;
        case 'replace_tag':
            await insertImageReplaceTag(messageIndex, originalTag, imageUrl, fullPositivePrompt, fullNegativePrompt, rawPrompt, loraPrompts);
            break;
        case 'disabled':
            console.log('[IGS] Image generation insert type is disabled, skipping insert');
            break;
        default:
            console.log('[IGS] Unknown insert type:', insertType, '- defaulting to in_message');
            insertImageInMessage(messageIndex, imageUrl, fullPositivePrompt, fullNegativePrompt, rawPrompt, loraPrompts);
            break;
    }

    // Save the chat
    await context.saveChat();
    console.log('[IGS] Image insertion complete for prompt:', rawPrompt);
}

/**
 * Attaches an image to an existing message at the specified index.
 *
 * @param {number} messageIndex - The index of the message to attach the image to.
 * @param {string} imageUrl - The URL/path of the saved image.
 * @param {string} prompt - The prompt used to generate the image (used as title).
 * @param {string} negativePrompt - The negative prompt used to generate the image.
 * @param {string} rawPrompt - The raw prompt text before construction.
 * @param {string} loraPrompts - The compiled LoRA prompts string to persist.
 */
export function insertImageInMessage(messageIndex, imageUrl, prompt, negativePrompt, rawPrompt, loraPrompts) {
    const context = getContext();
    const message = context.chat[messageIndex];

    if (!message) {
        console.error('[IGS] Message not found at index:', messageIndex);
        return;
    }

    if (!message.extra) {
        message.extra = {};
    }

    // Attach both legacy and modern media properties for maximum compatibility
    message.extra.image = imageUrl;
    message.extra.inline_image = true;
    message.extra.raw_prompt = rawPrompt;
    message.extra.negative_raw = negativePrompt;
    message.extra.lora_prompts = loraPrompts || '';
    applyPromptGetters(message);
    
    // Ensure image_swipes contains the image for swipe navigation compatibility
    if (!Array.isArray(message.extra.image_swipes)) {
        message.extra.image_swipes = [];
    }
    if (!message.extra.image_swipes.includes(imageUrl)) {
        message.extra.image_swipes.push(imageUrl);
    }

    message.extra.media = [{
        url: imageUrl,
        type: 'image',
        title: prompt,
        negative: negativePrompt,
        source: 'generated',
    }];
    message.extra.media_display = 'gallery';
    message.extra.media_index = 0;

    const messageElement = $(`.mes[mesid="${messageIndex}"]`);
    appendMediaToMessage(message, messageElement);

    console.log('[IGS] Inserted image into message:', messageIndex);
}

/**
 * Creates a new chat message containing the generated image.
 *
 * @param {string} imageUrl - The URL/path of the saved image.
 * @param {string} prompt - The prompt used to generate the image (used as title).
 * @param {string} negativePrompt - The negative prompt used to generate the image.
 * @param {string} rawPrompt - The raw prompt text before construction.
 * @param {boolean} hideFromLLM - If true, marks the message as a system message hidden from LLM context.
 * @param {string} loraPrompts - The compiled LoRA prompts string to persist.
 */
export function insertImageAsNewMessage(imageUrl, prompt, negativePrompt, rawPrompt, hideFromLLM, loraPrompts) {
    const context = getContext();

    const message = {
        name: context.name2 || 'System',
        is_user: false,
        is_system: hideFromLLM,
        send_date: getMessageTimeStamp(),
        mes: '',
        extra: {
            image: imageUrl,
            image_swipes: [imageUrl],
            inline_image: true,
            raw_prompt: rawPrompt,
            negative_raw: negativePrompt,
            lora_prompts: loraPrompts || '',
            media: [{
                url: imageUrl,
                type: 'image',
                title: prompt,
                negative: negativePrompt,
                source: 'generated',
            }],
            media_display: 'gallery',
            media_index: 0,
        },
    };

    applyPromptGetters(message);

    context.chat.push(message);
    const messageId = context.chat.length - 1;

    // Emit event before adding DOM element
    eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');

    // Add message to chat DOM
    context.addOneMessage(message);

    // Render media attached to new message
    const messageElement = $(`.mes[mesid="${messageId}"]`);
    appendMediaToMessage(message, messageElement);

    // Emit event after rendering
    eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');

    console.log('[IGS] Inserted image as new message, hidden:', hideFromLLM);
}

/**
 * Replaces the matched tag in the message text with an HTML img tag.
 *
 * @param {number} messageIndex - The index of the message containing the tag.
 * @param {string} originalTag - The original matched tag text to replace.
 * @param {string} imageUrl - The URL/path of the saved image.
 * @param {string} prompt - The prompt used to generate the image (used as alt/title).
 * @param {string} negativePrompt - The negative prompt used to generate the image.
 * @param {string} rawPrompt - The raw prompt text before construction.
 * @param {string} loraPrompts - The compiled LoRA prompts string to persist.
 */
export async function insertImageReplaceTag(messageIndex, originalTag, imageUrl, prompt, negativePrompt, rawPrompt, loraPrompts) {
    const context = getContext();
    const message = context.chat[messageIndex];

    if (!message) {
        console.error('[IGS] Message not found at index:', messageIndex);
        return;
    }

    // Escape special HTML characters for safe attribute insertion
    const escapedUrl = imageUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const escapedPrompt = prompt
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const imgTag = `<img src="${escapedUrl}" title="${escapedPrompt}" alt="${escapedPrompt}">`;

    message.mes = message.mes.replace(originalTag, imgTag);

    if (!message.extra) message.extra = {};
    message.extra.raw_prompt = rawPrompt;
    message.extra.negative_raw = negativePrompt;
    message.extra.lora_prompts = loraPrompts || '';
    applyPromptGetters(message);

    updateMessageBlock(messageIndex, message);

    await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);

    console.log('[IGS] Replaced tag with image in message:', messageIndex);
}

/**
 * Builds the fully resolved injection prompt content from the active profile,
 * including template, LoRA descriptions, character defining prompt, and custom macros.
 * This replicates the logic from detection.js promptInjectionHandler but without
 * the event/frequency/depth concerns.
 *
 * @param {object} profile - The active profile.
 * @returns {Promise<string>} The fully resolved injection content.
 */
async function buildInjectionContent(profile) {
    const settings = getSettings();
    let injectionContent = profile.prompt.template || '';

    // Scan for LoRA triggers in recent chat messages
    const context = getContext();
    const chat = context.chat || [];
    const loraDepth = (profile.loras && profile.loras.depth) ? profile.loras.depth : 5;
    const recentMessages = chat.slice(-loraDepth);
    const matches = await scanForTriggers(profile, recentMessages);

    if (matches.length > 0) {
        const loraDescriptions = compileLoraDescriptions(matches);
        if (loraDescriptions) {
            injectionContent += '\n' + loraDescriptions;
        }
    }

    // Append character defining prompt if a character is selected
    const charProfileId = profile.activeCharacterProfileId;
    const charProfile = charProfileId && settings.characterProfiles?.[charProfileId];
    const characters = charProfile?.characters || [];
    if (profile.activeCharacterId && characters.length > 0) {
        const selectedChar = characters.find(c => c.id === profile.activeCharacterId);
        if (selectedChar && selectedChar.prompt) {
            let charDefining = profile.promptConstruction?.characterDefining || '';
            if (charDefining) {
                charDefining = charDefining.replace(/\{character\}/g, selectedChar.prompt);

                let outfitsList = '';
                if (selectedChar.outfits && selectedChar.outfits.length > 0) {
                    outfitsList = selectedChar.outfits
                        .filter(o => o.name && o.description)
                        .map(o => `"${o.name}, ${o.description}"`)
                        .join(',\n');
                }
                charDefining = charDefining.replace(/\{outfits\}/g, outfitsList);

                injectionContent += '\n' + charDefining;
            }
        }
    }

    // Resolve custom macros
    if (profile.customMacros && profile.customMacros.length > 0) {
        for (const macro of profile.customMacros) {
            const resolved = resolveCustomMacro(macro);
            injectionContent = injectionContent.replaceAll(`{${macro.id}}`, resolved);
        }
    }

    return injectionContent;
}

/**
 * Replaces the image on an existing message in-place, adding to swipes.
 * Does NOT create a new message.
 *
 * @param {number} messageIndex - The chat index of the image message.
 * @param {string} newImageUrl - The URL of the new image.
 * @param {string} prompt - The compiled positive prompt.
 * @param {string} negativePrompt - The compiled negative prompt.
 * @param {string} rawPrompt - The raw prompt text.
 * @param {string} loraPrompts - The compiled LoRA prompts.
 */
function replaceImageOnMessage(messageIndex, newImageUrl, prompt, negativePrompt, rawPrompt, loraPrompts) {
    const context = getContext();
    const message = context.chat[messageIndex];
    if (!message || !message.extra) return;

    // Update raw prompt and LoRA prompts
    message.extra.raw_prompt = rawPrompt;
    message.extra.negative_raw = negativePrompt;
    message.extra.lora_prompts = loraPrompts || '';

    // Update image URL
    message.extra.image = newImageUrl;
    message.extra.inline_image = true;

    // Add to swipes array
    if (!Array.isArray(message.extra.image_swipes)) {
        message.extra.image_swipes = [];
    }
    message.extra.image_swipes.push(newImageUrl);

    // Update media array
    message.extra.media = [{
        url: newImageUrl,
        type: 'image',
        title: prompt,
        negative: negativePrompt,
        source: 'generated',
    }];
    message.extra.media_index = 0;

    // Re-apply prompt getters
    applyPromptGetters(message);

    // Re-render the message
    const messageElement = $(`.mes[mesid="${messageIndex}"]`);
    appendMediaToMessage(message, messageElement);
}

/**
 * Re-rolls the image prompt by sending a quiet LLM call with the full injection
 * template (macros, characters, LoRAs), then generates a new image and adds it
 * to swipes on the image message.
 *
 * @param {number} imageMessageIndex - The chat index of the image message (message #3).
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function rerollNewPrompt(imageMessageIndex) {
    const context = getContext();
    const chat = context.chat || [];
    const imageMessage = chat[imageMessageIndex];

    if (!imageMessage || !imageMessage.extra) {
        toastr.error('Could not find the image message.');
        return false;
    }

    // Find the parent assistant message (scan backwards for a non-system, non-user message)
    let parentIndex = null;
    for (let i = imageMessageIndex - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            parentIndex = i;
            break;
        }
    }

    if (parentIndex === null) {
        toastr.error('Could not find the parent assistant message.');
        return false;
    }

    const parentMessage = chat[parentIndex];
    const profile = getActiveProfile();
    if (!profile) {
        toastr.error('No active profile.');
        return false;
    }

    // Check generateQuietPrompt availability
    const generateQuietPrompt = context.generateQuietPrompt;
    if (typeof generateQuietPrompt !== 'function') {
        toastr.error('generateQuietPrompt is not available. Cannot re-roll prompt.');
        return false;
    }

    try {
        // Build the full injection content with current macros/characters/LoRAs
        const injectionContent = await buildInjectionContent(profile);

        // Build the quiet prompt including the parent message as context
        const quietPrompt = `[System instructions]\n${injectionContent}\n[End System instructions]\n\n[Current scene to describe]\n${parentMessage.mes}\n[End scene]\n\nBased on the scene above, generate your response with the image tag.`;

        console.log('[IGS] Re-roll prompt: sending quiet LLM call...');

        const rawResponse = await generateQuietPrompt({
            quietPrompt: quietPrompt,
            skipWIAN: true,
            responseLength: 500,
        });

        console.log('[IGS] Re-roll prompt: LLM response received');

        // Parse the response for image tags using the profile's regex
        const regexStr = profile.settings?.regex;
        if (!regexStr) {
            toastr.error('No detection regex configured.');
            return false;
        }

        const regex = regexFromString(regexStr);
        if (!regex) {
            toastr.error('Failed to parse detection regex.');
            return false;
        }

        const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
        const allMatches = [...rawResponse.matchAll(globalRegex)];

        if (allMatches.length === 0) {
            toastr.warning('LLM response did not contain an image tag. Try again.');
            console.log('[IGS] Re-roll prompt: no tags found in response:', rawResponse);
            return false;
        }

        const newRawPrompt = allMatches[0][1] || '';
        const newOriginalTag = allMatches[0][0];

        console.log('[IGS] Re-roll prompt: new raw prompt:', newRawPrompt);

        // Update the <pic> tag in the parent message
        const oldRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
        const oldMatches = [...(parentMessage.mes || '').matchAll(oldRegex)];
        if (oldMatches.length > 0) {
            // Replace the last (most recent) tag in the parent message
            const lastOldTag = oldMatches[oldMatches.length - 1][0];
            parentMessage.mes = parentMessage.mes.replace(lastOldTag, newOriginalTag);
            updateMessageBlock(parentIndex, parentMessage);
        }

        // Compile prompts from the new raw prompt
        const compiled = await compilePrompts(profile, newRawPrompt, parentIndex);
        const fullPositivePrompt = compiled.positive;
        const fullNegativePrompt = compiled.negative;
        const loraPrompts = compiled.loraPrompts || '';

        // Generate the image
        const result = await generateImage(profile, fullPositivePrompt, fullNegativePrompt);

        if (!result || !result.data) {
            toastr.error('Image generation returned no data.');
            return false;
        }

        // Save image file
        const charaFilename = getCharaFilename() || 'unknown';
        const imageUrl = await saveBase64AsFile(result.data, charaFilename, '', result.format);

        // Replace image on the image message (adds to swipes)
        replaceImageOnMessage(imageMessageIndex, imageUrl, fullPositivePrompt, fullNegativePrompt, newRawPrompt, loraPrompts);

        // Save chat
        await context.saveChat();

        toastr.success('Image re-rolled with new prompt!');
        console.log('[IGS] Re-roll prompt complete');
        return true;
    } catch (error) {
        console.error('[IGS] Re-roll prompt error:', error);
        toastr.error('Re-roll failed: ' + error.message);
        return false;
    }
}
