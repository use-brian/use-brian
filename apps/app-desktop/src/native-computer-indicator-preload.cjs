const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('stop').addEventListener('click', () => ipcRenderer.send('Use Brian:native-emergency-stop'));
  const labels = {
    unavailable: 'Native control unavailable',
    ready: 'Ready — not controlling',
    permission_required: 'Local permission required',
    awaiting_local_consent: 'Awaiting local consent — not controlling',
    active: 'Brian is observing or controlling',
    awaiting_action_approval: 'Awaiting local action approval',
    stopped: 'Stopped — not controlling',
    paused_for_user: 'Paused for you — not controlling',
    ended: 'Session ended — not controlling',
  };
  ipcRenderer.on('Use Brian:native-status', (_event, data) => {
    /** @type {import('./native-computer-integration.js').NativeIndicatorData} */
    const status = data;
    document.getElementById('state').textContent = labels[status.state] || 'Native control unavailable';
    const activity = ['active', 'awaiting_action_approval'].includes(status.state) ? status.activity : null;
    document.getElementById('app').textContent = activity ? `Target app: ${activity.appId}` : 'Target app: no action dispatched';
    document.getElementById('perception').textContent = activity ? `Actual perception: ${activity.perception === 'vision' ? 'Vision' : 'AX (accessibility)'}` : 'Actual perception: none yet';
    document.getElementById('shortcut').textContent = `Emergency stop: ${status.shortcut}`;
  });
});
