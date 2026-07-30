;(function () {
  let bridgePortPromise = null

  function createLNbitsExtensionClient({extensionId}) {
    const baseUrl = `/api/v1/ext/${extensionId}`

    return {
      context() {
        return bridgeRequest({action: 'context'})
      },

      notify(message, level = 'info') {
        return bridgeRequest({
          action: 'ui.notify',
          level,
          message: errorMessage(message)
        })
      },

      notifyError(message) {
        return bridgeRequest({
          action: 'ui.notify',
          level: 'negative',
          message: errorMessage(message)
        })
      },

      getStats(days = 30) {
        return request(`${baseUrl}/stats?days=${encodeURIComponent(days)}`)
      }
    }
  }

  function request(path, {method = 'GET', body = null} = {}) {
    return bridgeRequest({
      action: 'api',
      method,
      path,
      body
    }).then(unwrapRuntimeResponse)
  }

  function bridgeRequest(message) {
    if (window.parent === window) {
      return Promise.reject(new Error('LNbits extension bridge is not available.'))
    }
    return getBridgePort().then(port => bridgePortRequest(port, message))
  }

  function getBridgePort() {
    if (!bridgePortPromise) bridgePortPromise = connectBridge()
    return bridgePortPromise
  }

  function connectBridge() {
    const id = requestId()
    const channel = new MessageChannel()
    const parentOrigin = bridgeParentOrigin()

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        channel.port1.removeEventListener('message', onMessage)
        channel.port1.close()
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        if (event.currentTarget !== channel.port1) return
        const response = event.data
        if (
          !response ||
          response.type !== 'lnbits-extension:connected' ||
          response.id !== id
        ) {
          return
        }
        window.clearTimeout(timeout)
        channel.port1.removeEventListener('message', onMessage)
        resolve(channel.port1)
      }

      channel.port1.addEventListener('message', onMessage)
      channel.port1.start()
      window.parent.postMessage(
        {type: 'lnbits-extension:connect', id},
        parentOrigin,
        [channel.port2]
      )
    })
  }

  function bridgePortRequest(port, message) {
    const id = requestId()

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        port.removeEventListener('message', onMessage)
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        if (event.currentTarget !== port) return
        const response = event.data
        if (
          !response ||
          response.type !== 'lnbits-extension:response' ||
          response.id !== id
        ) {
          return
        }
        window.clearTimeout(timeout)
        port.removeEventListener('message', onMessage)
        if (response.ok === false) {
          reject(new Error(response.error || 'Extension call failed.'))
          return
        }
        resolve(response.data)
      }

      port.addEventListener('message', onMessage)
      port.postMessage({
        type: 'lnbits-extension:request',
        id,
        ...message
      })
    })
  }

  function unwrapRuntimeResponse(value) {
    const response = typeof value === 'string' ? JSON.parse(value) : value
    if (!response || response.ok !== true) {
      throw new Error(response?.error || 'InventoryStats request failed.')
    }
    return response.data
  }

  function bridgeParentOrigin() {
    try {
      if (document.referrer) return new URL(document.referrer).origin
    } catch {
      // Fall back to this page's origin.
    }
    return window.location.origin
  }

  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID()
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function errorMessage(value) {
    return value instanceof Error ? value.message : String(value)
  }

  window.createLNbitsExtensionClient = createLNbitsExtensionClient
})()
