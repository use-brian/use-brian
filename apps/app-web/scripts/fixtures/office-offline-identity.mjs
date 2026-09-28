// The only substituted production boundary: signed-in viewer identity.
export function getUserInfo() { return window.officeOfflineViewer ? {id: window.officeOfflineViewer} : null; }
