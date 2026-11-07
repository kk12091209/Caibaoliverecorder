import { ref, nextTick } from 'vue';

/** Opens settings sections and restores focus after navigation. */
export function useSettingsNavigation({
  state, modal, savedExportDirectory, exportDirectory, closeActionError
}) {
  const expandedSettings = ref({});
  function openCleanup() { return openSettingsSection('.cleanup-settings', { group: 'storage' }); }

  function openUpdateSettings() { return openSettingsSection('#settings-updates-title', { focus: '#settings-updates-title' }); }
  function openAbout() { return openSettingsSection('#settings-about-title', { focus: '#settings-about-title' }); }
  async function openSettingsSection(selector, { group, focus } = {}) {
    openSettings();
    if (group) expandedSettings.value[group] = true;
    await nextTick();
    document.querySelector(selector)?.scrollIntoView({ block: 'center' });
    if (focus) document.querySelector(focus)?.focus({ preventScroll: focus === selector });
  }
  function openSettings() {
    const current = state.value.paths?.exports || '';
    savedExportDirectory.value = current;
    exportDirectory.value = current;
    closeActionError.value = '';
    expandedSettings.value = {};
    modal.value = 'settings';
  }
  return {
    expandedSettings, openSettingsSection, openSettings, openCleanup, openUpdateSettings, openAbout
  };
}
