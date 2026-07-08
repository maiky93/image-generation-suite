import {
    getSettings,
    getActiveProfile,
    setActiveProfile,
    createProfile,
    deleteProfile,
    duplicateProfile,
    renameProfile,
    exportAllProfiles,
    importProfiles,
    saveProfiles,
    initSettings
} from './src/profiles.js';

import {
    initDetection,
    triggerDetection
} from './src/detection.js';

import { applyPromptGetters } from './src/insertion.js';
import { openSettingsModal, refreshModalUI } from './src/settingsModal.js';

import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const extensionName = 'image-generation-suite';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

/**
 * Populates the profile dropdown select element with all stored profiles.
 */
function populateProfileSelect() {
    const settings = getSettings();
    const select = $('#igs_profile_select');
    select.empty();

    Object.keys(settings.profiles).forEach(id => {
        const profile = settings.profiles[id];
        select.append($('<option>', { value: profile.id, text: profile.name }));
    });

    select.val(settings.activeProfileId);
}

/**
 * Populates the character dropdown inside the floating hub window.
 */
function populateFloatingCharacterSelect() {
    const settings = getSettings();
    const profile = getActiveProfile();
    const select = $('#igs_hub_character_select');
    if (!select.length) return;
    select.empty();

    select.append($('<option>', { value: '', text: '(None)' }));

    const charProfileId = profile?.activeCharacterProfileId;
    const charProfile = charProfileId && settings.characterProfiles?.[charProfileId];
    const characters = charProfile?.characters || [];

    characters.forEach(char => {
        select.append($('<option>', { value: char.id, text: char.name || '(Unnamed)' }));
    });

    select.val(profile?.activeCharacterId || '');
}

/**
 * Populates the styles select dropdown inside the floating picker window based on the active Styles Profile.
 */
function populateFloatingStyleSelect() {
    const settings = getSettings();
    const profile = getActiveProfile();
    const container = $('#igs_custom_style_select .igs-custom-select-options');
    const trigger = $('#igs_custom_style_select .igs-custom-select-trigger span');
    
    if (!container.length) return;
    container.empty();

    const activeStyle = profile?.activeStyleName || 'Default';
    
    container.append(`
        <div class="igs-custom-select-option${activeStyle === 'Default' ? ' selected' : ''}" data-value="Default">
            Default (No Style)
        </div>
    `);

    let selectedText = 'Default (No Style)';

    if (profile && profile.activeStyleProfileId && settings.styleProfiles) {
        const stylesProfile = settings.styleProfiles[profile.activeStyleProfileId];
        if (stylesProfile && stylesProfile.styles) {
            stylesProfile.styles.forEach(s => {
                const isSelected = activeStyle === s.name;
                if (isSelected) {
                    selectedText = s.name;
                }
                container.append(`
                    <div class="igs-custom-select-option${isSelected ? ' selected' : ''}" data-value="${s.name}">
                        ${s.name}
                    </div>
                `);
            });
        }
    }

    trigger.text(selectedText);
}

/**
 * Renders compact controls for each user custom macro in the floating hub window.
 * Called from updateFloatingWindow() to keep the macro controls in sync with the profile.
 */
function populateHubMacros() {
    const container = $('#igs_hub_macros_container');
    if (!container.length) return;

    const profile = getActiveProfile();
    const macros = profile?.customMacros || [];

    if (macros.length === 0) {
        container.html('<div class="igs-hub-macros-empty"><small>No custom macros defined.<br>Add them in Settings → Prompt Injection.</small></div>').show();
        return;
    }

    let html = '';
    macros.forEach((macro, i) => {
        html += `<div class="igs-hub-macro-row" data-macro-index="${i}">`;
        html += `<label><small>${macro.id}:</small></label>`;

        switch (macro.type) {
            case 'list':
                html += `<select class="text_pole igs-hub-macro-select" data-macro-index="${i}">`;
                (macro.options || []).forEach((opt, oi) => {
                    let displayLabel;
                    if (typeof opt === 'object') {
                        displayLabel = opt.label || opt.text || `Option ${oi + 1}`;
                    } else {
                        displayLabel = opt || `Option ${oi + 1}`;
                    }
                    if (displayLabel.length > 40) displayLabel = displayLabel.substring(0, 37) + '...';
                    html += `<option value="${oi}" ${macro.value === oi ? 'selected' : ''}>${displayLabel}</option>`;
                });
                html += '</select>';
                break;
            case 'bool':
                html += `<label class="igs-hub-macro-bool">`;
                html += `<input type="checkbox" class="checkbox igs-hub-macro-checkbox" data-macro-index="${i}" ${macro.value ? 'checked' : ''}>`;
                html += `<small>${macro.value ? 'ON' : 'OFF'}</small>`;
                html += `</label>`;
                break;
            case 'int':
                html += `<input type="number" class="text_pole igs-hub-macro-number" data-macro-index="${i}" value="${macro.value ?? 0}" min="${macro.min ?? 0}" max="${macro.max ?? 100}" step="${macro.step ?? 1}">`;
                break;
            case 'float':
                html += `<input type="number" class="text_pole igs-hub-macro-number" data-macro-index="${i}" value="${macro.value ?? 0}" min="${macro.min ?? 0}" max="${macro.max ?? 1}" step="${macro.step ?? 0.1}">`;
                break;
        }

        html += '</div>';
    });

    container.html(html).show();
}

/**
 * Syncs and updates the floating style picker window position, size, docked state, visibility, and active style previews.
 */
function updateFloatingWindow() {
    const settings = getSettings();
    const win = $('#igs_floating_style_window');
    
    if (!win.length) return;

    // Apply visibility
    if (settings.style_show_window) {
        win.css('display', 'flex');
        $('#igs_hub_show_window').prop('checked', true);
    } else {
        win.hide();
        $('#igs_hub_show_window').prop('checked', false);
        return; // No need to calculate layout if hidden
    }
    
    $('#igs_hub_show_previews').prop('checked', !!settings.style_show_previews);

    // Apply size if not docked
    if (!settings.window_docked) {
        if (settings.window_size) {
            win.css({
                width: settings.window_size.width + 'px',
                height: settings.window_size.height + 'px'
            });
        } else {
            win.css({
                width: '420px',
                height: '320px'
            });
        }
    }

    // Apply docked state or position
    if (settings.window_docked) {
        win.removeClass('igs-docked-left igs-docked-right').addClass('igs-docked-' + settings.window_docked);
        win.addClass('igs-collapsed');
        win.css({
            top: (settings.window_position?.top || 100) + 'px',
            left: settings.window_docked === 'left' ? '0px' : 'auto',
            right: settings.window_docked === 'right' ? '0px' : 'auto',
            width: '32px',
            height: '180px'
        });
    } else {
        win.removeClass('igs-docked-left igs-docked-right igs-collapsed');
        if (settings.window_position) {
            win.css({
                top: settings.window_position.top + 'px',
                left: settings.window_position.left + 'px',
                right: 'auto'
            });
        }
    }
    
    const profile = getActiveProfile();
    const previewContainer = $('#igs_window_preview_container');
    
    if (settings.style_show_previews && profile && profile.activeStyleName && profile.activeStyleName !== 'Default') {
        const stylesProfile = settings.styleProfiles?.[profile.activeStyleProfileId];
        const style = stylesProfile?.styles?.find(s => s.name === profile.activeStyleName);
        if (style) {
            $('#igs_window_preview_img').attr('src', style.preview_image || '');
            $('#igs_window_desc').text(style.description || '');
            
            if (style.preview_image) {
                $('#igs_window_preview_img').show();
                $('.igs-window-preview-img-wrapper').show();
            } else {
                $('#igs_window_preview_img').hide();
                $('.igs-window-preview-img-wrapper').hide();
            }
            previewContainer.show();
        } else {
            previewContainer.hide();
        }
    } else {
        previewContainer.hide();
    }

    // Render custom macro controls in the hub
    populateHubMacros();
}

/**
 * Handle snapping left or right screen borders
 */
function handleDockSnapping(left, top) {
    const win = $('#igs_floating_style_window');
    const settings = getSettings();
    const vpWidth = $(window).width();
    const threshold = 30;
    const winW = win.outerWidth();

    let docked = false;
    let side = null;

    if (left <= threshold) {
        docked = true;
        side = 'left';
    } else if ((vpWidth - left - winW) <= threshold) {
        docked = true;
        side = 'right';
    }

    if (docked) {
        win.removeClass('igs-docked-left igs-docked-right').addClass('igs-docked-' + side).addClass('igs-collapsed');
        win.css({
            top: top + 'px',
            left: side === 'left' ? '0px' : 'auto',
            right: side === 'right' ? '0px' : 'auto',
            width: '32px',
            height: '180px'
        });
        settings.window_docked = side;
        settings.window_position = { top: top, left: side === 'left' ? 0 : vpWidth - winW };
    } else {
        win.removeClass('igs-docked-left igs-docked-right igs-collapsed');
        win.css({
            left: left + 'px',
            top: top + 'px',
            right: 'auto'
        });
        settings.window_docked = null;
        settings.window_position = { top: top, left: left };
    }
    saveProfiles();
}

/**
 * Initializes dragging and resizable capabilities for the floating window, snapping/docking, and hover expansions.
 */
function setupDragging() {
    const win = $('#igs_floating_style_window');
    if (!win.length) return;
    const settings = getSettings();

    // 1. Resizable Setup
    if (typeof win.resizable === 'function') {
        win.resizable({
            handles: 'se',
            minWidth: 380,
            minHeight: 280,
            maxWidth: 800,
            maxHeight: 700,
            stop: function (event, ui) {
                if (!win.hasClass('igs-docked-left') && !win.hasClass('igs-docked-right')) {
                    settings.window_size = {
                        width: ui.size.width,
                        height: ui.size.height
                    };
                    saveProfiles();
                }
            }
        });
    } else {
        // Fallback vanilla resize
        if (!win.find('.ui-resizable-se').length) {
            win.append('<div class="ui-resizable-handle ui-resizable-se"></div>');
        }
        const grip = win.find('.ui-resizable-se');
        let isResizing = false;
        let startW, startH, startX, startY;

        grip.on('mousedown', function (e) {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startW = win.outerWidth();
            startH = win.outerHeight();
            e.preventDefault();
            e.stopPropagation();
        });

        $(document).on('mousemove.igs-resize', function (e) {
            if (!isResizing) return;
            const dw = e.clientX - startX;
            const dy = e.clientY - startY;
            const newW = Math.max(380, Math.min(800, startW + dw));
            const newH = Math.max(280, Math.min(700, startH + dy));
            win.css({
                width: newW + 'px',
                height: newH + 'px'
            });
        });

        $(document).on('mouseup.igs-resize', function () {
            if (isResizing) {
                isResizing = false;
                if (!win.hasClass('igs-docked-left') && !win.hasClass('igs-docked-right')) {
                    settings.window_size = {
                        width: win.outerWidth(),
                        height: win.outerHeight()
                    };
                    saveProfiles();
                }
            }
        });
    }

    // 2. Dragging & Snapping / Docking Setup
    if (typeof win.draggable === 'function') {
        win.draggable({
            handle: '.igs-window-header',
            start: function (event, ui) {
                if (win.hasClass('igs-docked-left') || win.hasClass('igs-docked-right')) {
                    win.removeClass('igs-docked-left igs-docked-right igs-collapsed');
                    win.css({ right: 'auto' });
                    if (settings.window_size) {
                        win.css({
                            width: settings.window_size.width + 'px',
                            height: settings.window_size.height + 'px'
                        });
                    }
                }
            },
            drag: function (event, ui) {
                if (win.hasClass('igs-docked-left') || win.hasClass('igs-docked-right')) {
                    const side = win.hasClass('igs-docked-left') ? 'left' : 'right';
                    const vpWidth = $(window).width();
                    const winW = win.outerWidth();
                    const currentLeft = ui.position.left;
                    let shouldUndock = false;

                    if (side === 'left' && currentLeft > 30) shouldUndock = true;
                    else if (side === 'right' && (vpWidth - currentLeft - winW) > 30) shouldUndock = true;

                    if (shouldUndock) {
                        win.removeClass('igs-docked-left igs-docked-right igs-collapsed');
                        win.css({ right: 'auto' });
                        if (settings.window_size) {
                            win.css({
                                width: settings.window_size.width + 'px',
                                height: settings.window_size.height + 'px'
                            });
                        }
                    }
                }
            },
            stop: function (event, ui) {
                handleDockSnapping(ui.position.left, ui.position.top);
            }
        });
    } else {
        // Fallback vanilla drag with snap
        const header = win.find('.igs-window-header');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.on('mousedown', function (e) {
            if ($(e.target).hasClass('igs-window-close')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = parseInt(win.css('left')) || 100;
            startTop = parseInt(win.css('top')) || 100;

            if (win.hasClass('igs-docked-left') || win.hasClass('igs-docked-right')) {
                win.removeClass('igs-docked-left igs-docked-right igs-collapsed');
                win.css({ right: 'auto' });
                if (settings.window_size) {
                    win.css({
                        width: settings.window_size.width + 'px',
                        height: settings.window_size.height + 'px'
                    });
                }
            }
            e.preventDefault();
        });

        $(document).on('mousemove.igs-drag', function (e) {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const left = startLeft + dx;
            const top = startTop + dy;

            if (win.hasClass('igs-docked-left') || win.hasClass('igs-docked-right')) {
                const side = win.hasClass('igs-docked-left') ? 'left' : 'right';
                const vpWidth = $(window).width();
                const winW = win.outerWidth();
                let shouldUndock = false;

                if (side === 'left' && left > 30) shouldUndock = true;
                else if (side === 'right' && (vpWidth - left - winW) > 30) shouldUndock = true;

                if (shouldUndock) {
                    win.removeClass('igs-docked-left igs-docked-right igs-collapsed');
                    win.css({ right: 'auto' });
                    if (settings.window_size) {
                        win.css({
                            width: settings.window_size.width + 'px',
                            height: settings.window_size.height + 'px'
                        });
                    }
                }
            }

            win.css({
                left: left + 'px',
                top: top + 'px'
            });
        });

        $(document).on('mouseup.igs-drag', function () {
            if (isDragging) {
                isDragging = false;
                const left = parseInt(win.css('left')) || 100;
                const top = parseInt(win.css('top')) || 100;
                handleDockSnapping(left, top);
            }
        });
    }

    // 3. Hover expansion/collapsing for side drawers
    let hoverTimeout = null;

    $(document).off('mouseenter.igs-dock').on('mouseenter.igs-dock', '#igs_floating_style_window', function () {
        if (win.hasClass('igs-docked-left') || win.hasClass('igs-docked-right')) {
            clearTimeout(hoverTimeout);
            win.removeClass('igs-collapsed');
            if (settings.window_size) {
                win.css({
                    width: settings.window_size.width + 'px',
                    height: settings.window_size.height + 'px'
                });
            } else {
                win.css({
                    width: '420px',
                    height: '320px'
                });
            }
        }
    });

    $(document).off('mouseleave.igs-dock').on('mouseleave.igs-dock', '#igs_floating_style_window', function () {
        if (win.hasClass('igs-docked-left') || win.hasClass('igs-docked-right')) {
            hoverTimeout = setTimeout(() => {
                if (!win.hasClass('ui-draggable-dragging') && !win.hasClass('ui-resizable-resizing')) {
                    win.addClass('igs-collapsed');
                    win.css({
                        width: '32px',
                        height: '180px'
                    });
                }
            }, 250);
        }
    });
}

/**
 * Registers the /suitehub slash command to toggle the Suite Hub window visibility.
 */
function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'suitehub',
        aliases: ['igs-hub'],
        returns: 'toggles visibility of the suite hub window',
        helpString: 'Toggles the floating Suite Hub window.',
        callback: () => {
            const btn = $('#igs_hub_show_window');
            const show = !btn.prop('checked');
            btn.prop('checked', show).trigger('change');
            return '';
        }
    }));
    console.log('[IGS] Registered slash command /suitehub');

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'suitetrigger',
        aliases: ['igs-trigger'],
        returns: 're-reads the latest character message to scan for tags and generate images',
        helpString: 'Re-scans the latest character message for image tags and runs generation.',
        callback: () => {
            triggerDetection();
            return '';
        }
    }));
    console.log('[IGS] Registered slash command /suitetrigger');
}

/**
 * Scans the current chat history and binds dynamic prompt getters to any message cards
 * containing custom raw prompts.
 */
function scanAndApplyGetters() {
    const context = getContext();
    const chat = context.chat || [];
    chat.forEach(message => {
        if (message && message.extra && message.extra.raw_prompt) {
            applyPromptGetters(message);
        }
    });
}

/**
 * Updates all UI element values to match the active profile configuration.
 * Now only updates the drawer stub and floating hub window.
 */
function updateUIValues() {
    const profile = getActiveProfile();
    if (!profile) return;

    // Profile Bar select (drawer)
    populateProfileSelect();

    // Enable extension toggle (drawer)
    $('#igs_extension_enabled').prop('checked', !!profile.prompt.enabled);

    // Floating hub window updates
    populateFloatingStyleSelect();
    populateFloatingCharacterSelect();
    updateFloatingWindow();

    // If settings modal is open, refresh it
    refreshModalUI();
}

/**
 * Sets up profile-related action click bindings.
 */
function setupProfileEvents() {
    $('#igs_profile_select').on('change', function () {
        const id = $(this).val();
        setActiveProfile(id);
        updateUIValues();
    });

    $('#igs_profile_add').on('click', function () {
        const name = prompt('Enter a name for the new profile:');
        if (!name || name.trim() === '') return;
        createProfile(name.trim());
        updateUIValues();
    });

    $('#igs_profile_duplicate').on('click', function () {
        const profile = getActiveProfile();
        if (!profile) return;
        duplicateProfile(profile.id);
        updateUIValues();
    });

    $('#igs_profile_rename').on('click', function () {
        const profile = getActiveProfile();
        if (!profile) return;
        const newName = prompt('Enter a new name for the profile:', profile.name);
        if (!newName || newName.trim() === '' || newName.trim() === profile.name) return;
        renameProfile(profile.id, newName.trim());
        updateUIValues();
    });

    $('#igs_profile_delete').on('click', function () {
        const profile = getActiveProfile();
        if (!profile) return;
        if (confirm(`Are you sure you want to delete profile "${profile.name}"?`)) {
            deleteProfile(profile.id);
            updateUIValues();
        }
    });

    $('#igs_profile_export').on('click', function () {
        exportAllProfiles();
    });

    $('#igs_profile_import').on('click', function () {
        $('#igs_profile_import_file').trigger('click');
    });

    $('#igs_profile_import_file').on('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (evt) {
            const success = importProfiles(evt.target.result);
            if (success) {
                toastr.success('Profiles imported successfully!');
                updateUIValues();
            }
            $('#igs_profile_import_file').val('');
        };
        reader.readAsText(file);
    });
}

/**
 * Sets up drawer-level UI bindings and the floating hub window events.
 */
function setupUI() {
    setupProfileEvents();

    // Enable extension toggle (maps to prompt.enabled)
    $('#igs_extension_enabled').on('change', function () {
        const enabled = $(this).prop('checked');
        getActiveProfile().prompt.enabled = enabled;
        saveProfiles();
    });

    // Open Settings button â†’ opens the tabbed modal
    $('#igs_open_settings').on('click', function () {
        openSettingsModal({
            onProfileSwitch: updateUIValues,
            updateFloatingWindow: updateFloatingWindow,
            populateFloatingStyleSelect: populateFloatingStyleSelect,
            populateFloatingCharacterSelect: populateFloatingCharacterSelect
        });
    });

    // === Floating Hub Window Event Handlers ===

    // Toggle custom style select dropdown menu visibility
    $(document).on('click.igs-custom-select', '#igs_custom_style_select .igs-custom-select-trigger', function(e) {
        e.stopPropagation();
        const options = $(this).siblings('.igs-custom-select-options');
        
        // Close other dropdowns if any, then toggle this one
        $('.igs-custom-select-options').not(options).removeClass('open');
        options.toggleClass('open');
    });

    // Close style selector dropdown menu if clicked anywhere else
    $(document).on('click.igs-custom-select-close', function() {
        $('.igs-custom-select-options').removeClass('open');
    });

    // Selection click event on custom option items
    $(document).on('click.igs-custom-select-opt', '#igs_custom_style_select .igs-custom-select-option', function() {
        const val = $(this).data('value');
        const profile = getActiveProfile();
        profile.activeStyleName = val;
        saveProfiles();

        // Hide hover preview tooltip immediately on selection
        $('#igs_dropdown_preview_tooltip').hide().find('img').attr('src', '');

        // Update UI
        populateFloatingStyleSelect();
        updateFloatingWindow();
    });

    // Cursor-attached hover preview tooltip mouse enter, move, and leave listeners
    $(document).on('mouseenter.igs-custom-select-hover', '#igs_custom_style_select .igs-custom-select-option', function() {
        const val = $(this).data('value');
        const profile = getActiveProfile();
        const settings = getSettings();
        
        let previewImg = '';
        if (val !== 'Default' && profile && profile.activeStyleProfileId && settings.styleProfiles) {
            const stylesProfile = settings.styleProfiles[profile.activeStyleProfileId];
            const style = stylesProfile?.styles?.find(s => s.name === val);
            if (style && style.preview_image) {
                previewImg = style.preview_image;
            }
        }

        const tooltip = $('#igs_dropdown_preview_tooltip');
        if (previewImg && tooltip.length) {
            tooltip.find('img').attr('src', previewImg);
            tooltip.show();
        } else {
            tooltip.hide();
        }
    });

    $(document).on('mousemove.igs-custom-select-hover', '#igs_custom_style_select .igs-custom-select-option', function(e) {
        const tooltip = $('#igs_dropdown_preview_tooltip');
        if (tooltip.is(':visible')) {
            tooltip.css({
                top: (e.clientY + 15) + 'px',
                left: (e.clientX + 15) + 'px'
            });
        }
    });

    $(document).on('mouseleave.igs-custom-select-hover', '#igs_custom_style_select .igs-custom-select-option', function() {
        $('#igs_dropdown_preview_tooltip').hide().find('img').attr('src', '');
    });

    $(document).on('click', '#igs_floating_style_window .igs-window-close', function() {
        const settings = getSettings();
        settings.style_show_window = false;
        saveProfiles();
        updateFloatingWindow();
    });

    // Hub window character select
    $(document).on('change', '#igs_hub_character_select', function() {
        const profile = getActiveProfile();
        profile.activeCharacterId = $(this).val();
        saveProfiles();
    });

    // Hub window prompt extra fields
    $(document).on('input', '#igs_hub_prompt_extra', function() {
        const profile = getActiveProfile();
        if (!profile.hub) profile.hub = {};
        profile.hub.promptExtra = $(this).val();
        saveProfiles();
    });

    $(document).on('input', '#igs_hub_negative_extra', function() {
        const profile = getActiveProfile();
        if (!profile.hub) profile.hub = {};
        profile.hub.negativeExtra = $(this).val();
        saveProfiles();
    });

    // Hub footer: Open Settings button
    $(document).on('click', '#igs_hub_open_settings', function() {
        openSettingsModal({
            onProfileSwitch: updateUIValues,
            updateFloatingWindow: updateFloatingWindow,
            populateFloatingStyleSelect: populateFloatingStyleSelect,
            populateFloatingCharacterSelect: populateFloatingCharacterSelect
        });
    });

    // Hub footer: Re-trigger image generation
    $(document).on('click', '#igs_hub_retrigger', function() {
        triggerDetection();
    });

    // Hub tab switching
    $(document).on('click', '.igs-hub-tab', function() {
        const tabId = $(this).data('hub-tab');
        const hub = $(this).closest('.igs-hub-controls');
        hub.find('.igs-hub-tab').removeClass('active');
        $(this).addClass('active');
        hub.find('.igs-hub-tab-panel').removeClass('active');
        hub.find(`.igs-hub-tab-panel[data-hub-panel="${tabId}"]`).addClass('active');
    });

    // Hub macro controls
    $(document).on('change', '.igs-hub-macro-select', function() {
        const idx = parseInt($(this).data('macro-index'), 10);
        const profile = getActiveProfile();
        if (profile.customMacros && profile.customMacros[idx]) {
            profile.customMacros[idx].value = parseInt($(this).val(), 10);
            saveProfiles();
        }
    });

    $(document).on('change', '.igs-hub-macro-checkbox', function() {
        const idx = parseInt($(this).data('macro-index'), 10);
        const profile = getActiveProfile();
        if (profile.customMacros && profile.customMacros[idx]) {
            profile.customMacros[idx].value = $(this).prop('checked');
            $(this).siblings('small').text(profile.customMacros[idx].value ? 'ON' : 'OFF');
            saveProfiles();
        }
    });

    $(document).on('input', '.igs-hub-macro-number', function() {
        const idx = parseInt($(this).data('macro-index'), 10);
        const profile = getActiveProfile();
        if (profile.customMacros && profile.customMacros[idx]) {
            const macro = profile.customMacros[idx];
            let val = parseFloat($(this).val());
            if (isNaN(val)) return;
            if (macro.min !== undefined) val = Math.max(macro.min, val);
            if (macro.max !== undefined) val = Math.min(macro.max, val);
            macro.value = macro.type === 'int' ? Math.round(val) : val;
            saveProfiles();
        }
    });

    // Load initial values
    updateUIValues();
}

// Initialise the extension on document ready
$(function () {
    (async function () {
        // Initialise settings and active profile structure
        initSettings();

        // Retrieve settings HTML
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);

        // Append extension to main settings menu dropdown
        $('#extensionsMenu').append(`
            <div id="igs_extension_menu" class="list-group-item flex-container flexGap5">
                <div class="fa-solid fa-image"></div>
                <span data-i18n="Image Generation Suite">Image Gen Suite</span>
            </div>
        `);

        // Click handler to open the extensions drawer and scroll to the settings panel
        $('#igs_extension_menu').on('click', function () {
            if ($('#rm_extensions_block').hasClass('closedDrawer')) {
                $('#extensions-settings-button .drawer-toggle').trigger('click');
            }

            setTimeout(() => {
                const container = $('.igs-container');
                if (container.length) {
                    $('#rm_extensions_block').animate({
                        scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop()
                    }, 500);

                    // Expand drawer content if collapsed
                    const content = container.find('.inline-drawer-content').first();
                    const header = container.find('.inline-drawer-header').first();
                    if (content.is(':hidden') && header.length) {
                        header.trigger('click');
                    }
                }
            }, 500);
        });

        // Create target container for extension settings if not exists
        if (!$('#igs_settings_container').length) {
            $('#extensions_settings2').append('<div id="igs_settings_container" class="extension_container"></div>');
        }

        // Insert settings panel HTML content
        $('#igs_settings_container').empty().append(settingsHtml);

        // Inject floating Suite Hub window to the body
        if (!$('#igs_floating_style_window').length) {
            $('body').append(`
                <div id="igs_floating_style_window" class="igs-draggable-window">
                    <div class="igs-dock-handle" title="Expand Suite Hub">
                        <i class="fa-solid fa-house-chimney"></i>
                    </div>
                    <div class="igs-window-header">
                        <span>Suite Hub</span>
                        <i class="fa-solid fa-xmark igs-window-close" title="Close"></i>
                    </div>
                    <div class="igs-window-content igs-hub-layout">
                        <div class="igs-hub-preview">
                            <div id="igs_window_preview_container" style="display: none;">
                                <div class="igs-window-preview-img-wrapper">
                                    <img id="igs_window_preview_img" class="igs-window-preview-img" src="">
                                </div>
                                <div id="igs_window_desc" class="igs-window-desc"></div>
                            </div>
                        </div>
                        <div class="igs-hub-controls">
                            <div class="igs-hub-tabs">
                                <button class="igs-hub-tab active" data-hub-tab="controls"><i class="fa-solid fa-sliders"></i> Controls</button>
                                <button class="igs-hub-tab" data-hub-tab="macros"><i class="fa-solid fa-code"></i> Macros</button>
                            </div>
                            <div class="igs-hub-tab-panel active" data-hub-panel="controls">
                                <div class="igs-hub-row">
                                    <label><small>Character:</small></label>
                                    <select id="igs_hub_character_select" class="text_pole">
                                        <option value="">(None)</option>
                                    </select>
                                </div>
                                <hr class="igs-hub-divider">
                                <div class="igs-hub-row">
                                    <label><small>Prompt Addition:</small></label>
                                    <input type="text" id="igs_hub_prompt_extra" class="text_pole" placeholder="Extra positive prompt...">
                                </div>
                                <div class="igs-hub-row">
                                    <label><small>Negative Addition:</small></label>
                                    <input type="text" id="igs_hub_negative_extra" class="text_pole" placeholder="Extra negative prompt...">
                                </div>
                                <hr class="igs-hub-divider">
                                <div class="igs-hub-row">
                                    <label><small>Style:</small></label>
                                    <div id="igs_custom_style_select" class="igs-custom-select">
                                        <div class="igs-custom-select-trigger">
                                            <span>Default (No Style)</span>
                                            <i class="fa-solid fa-chevron-down"></i>
                                        </div>
                                        <div class="igs-custom-select-options">
                                            <!-- Rendered dynamically -->
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="igs-hub-tab-panel" data-hub-panel="macros">
                                <div id="igs_hub_macros_container" class="igs-hub-macros">
                                    <!-- Rendered dynamically by populateHubMacros() -->
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="igs-hub-footer">
                        <button id="igs_hub_open_settings" class="igs-hub-footer-btn" title="Open Settings">
                            <i class="fa-solid fa-gear"></i>
                        </button>
                        <button id="igs_hub_retrigger" class="igs-hub-footer-btn" title="Re-trigger Image Generation">
                            <i class="fa-solid fa-arrows-rotate"></i>
                            <span>Re-trigger</span>
                        </button>
                    </div>
                </div>
            `);
            setupDragging();
        }

        // Inject floating hover tooltip for dropdown previews
        if (!$('#igs_dropdown_preview_tooltip').length) {
            $('body').append('<div id="igs_dropdown_preview_tooltip" style="display:none;"><img src="" alt="Preview"></div>');
        }

        // Register slash commands
        registerSlashCommand();

        // Bind UI input handlers and load settings
        setupUI();

        // Initialise prompt injection and detection pipeline listeners
        initDetection();

        // Scan current chat history and register event listeners to re-apply getters on chat load
        scanAndApplyGetters();
        eventSource.on(event_types.CHAT_LOADED, scanAndApplyGetters);

        console.log('[IGS] Image Generation Suite extension loaded successfully.');
    })();
});


