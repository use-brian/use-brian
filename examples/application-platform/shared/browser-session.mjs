/** Memory-only application session. [COMP:examples/application-references] */
export function createBrowserSession({ appId, workspaceId, apiOrigin, createClient, createTransport, onClear = () => {}, now = Date.now }) {
  if (!appId || !workspaceId || new URL(apiOrigin).origin !== apiOrigin) throw new Error('Invalid public application configuration')
  const binding = Object.freeze({ appId, workspaceId, apiOrigin })
  let token, expiresAt = 0, generation = 0, connected = true, uncertain
  const controllers = new Set()
  const clear = () => { generation++; token = undefined; expiresAt = 0; for (const controller of controllers) controller.abort(); controllers.clear(); onClear() }
  const current = () => { if (!connected || !token || expiresAt <= now()) { clear(); throw new Error('Sign in and read again') } }
  const client = createClient({ appId, transport: createTransport({ apiOrigin, credential: async () => { current(); return token } }) })
  return {
    binding,
    authenticate(result) { clear(); if (!result || !/^oat_[A-Za-z0-9_-]+$/.test(result.accessToken) || !Number.isFinite(result.expiresIn) || result.expiresIn <= 0) throw new Error('Invalid sign in'); token = result.accessToken; expiresAt = now() + Math.min(result.expiresIn * 1000, 2147483647) },
    invalidate: clear,
    setOnline(value) { connected = value === true; clear() },
    get uncertain() { return uncertain ? { ...uncertain } : undefined },
    async call(operation, { write = false, idempotencyKey } = {}) {
      current()
      if (write && uncertain) throw new Error('Reconcile the previous write first')
      if (write && !idempotencyKey) throw new Error('An idempotency key is required')
      const epoch = generation, controller = new AbortController(); controllers.add(controller)
      // Callers clear before reads so previously admitted bytes are never an offline fallback.
      onClear()
      try {
        const result = await operation(client, { signal: controller.signal })
        if (epoch !== generation || !connected || expiresAt <= now()) {
          if (write) uncertain = { idempotencyKey, effect: 'uncertain' }
          throw new Error('The session changed; read again')
        }
        return result
      } catch (error) {
        if (write && error?.effect !== 'none') uncertain = { idempotencyKey, effect: error?.effect === 'committed' ? 'committed' : 'uncertain' }
        if (error?.status === 401 || error?.status === 403 || error?.code === 'access_unavailable' || error?.code === 'authentication_required') clear()
        throw error
      } finally { controllers.delete(controller) }
    },
    async reconcile(readCurrentReceipt) {
      current()
      if (typeof readCurrentReceipt !== 'function') throw new Error('Read the current server receipt first')
      const receipt = await this.call(readCurrentReceipt)
      if (!uncertain || !receipt || receipt.idempotencyKey !== uncertain.idempotencyKey || !['committed','not_applied'].includes(receipt.effect)) throw new Error('A current matching receipt is required')
      uncertain = undefined
    },
  }
}
