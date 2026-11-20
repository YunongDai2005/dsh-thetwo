const keys = ['deviceName', 'syncEnabled', 'discoverable', 'intervalSeconds']

export function validateSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !keys.includes(key))) throw new Error('设置包含不支持的选项')
  if (typeof values.deviceName !== 'string' || !values.deviceName.trim() || values.deviceName.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(values.deviceName)) throw new Error('设备名称需要 1–64 个字符')
  if (typeof values.syncEnabled !== 'boolean' || typeof values.discoverable !== 'boolean') throw new Error('同步和发现设置需要开关值')
  if (![5, 10, 30, 60].includes(values.intervalSeconds)) throw new Error('检查间隔可选 5、10、30 或 60 秒')
  return { deviceName: values.deviceName.trim(), syncEnabled: values.syncEnabled, discoverable: values.discoverable, intervalSeconds: values.intervalSeconds }
}

export function validatePeerSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !['deviceName', 'syncApiKeys', 'syncPlugins', 'acceptConfirmedTasks'].includes(key))) throw new Error('设备设置包含不支持的选项')
  if (typeof values.deviceName !== 'string' || values.deviceName.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(values.deviceName)) throw new Error('设备名称最多 64 个字符，留空使用原名')
  if (typeof values.syncApiKeys !== 'boolean' || typeof values.syncPlugins !== 'boolean') throw new Error('可选同步内容需要开关值')
  if ('acceptConfirmedTasks' in values && typeof values.acceptConfirmedTasks !== 'boolean') throw new Error('任务交接需要开关值')
  return { deviceName: values.deviceName.trim(), syncApiKeys: values.syncApiKeys, syncPlugins: values.syncPlugins, ...(values.acceptConfirmedTasks && { acceptConfirmedTasks: true }) }
}
