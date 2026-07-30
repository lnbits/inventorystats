import {
  extensionApiRequest,
  log,
  now
} from 'lnbits:extension/host'

export const extension = {
  request({extensionId, method = 'GET', path, body = undefined}) {
    const response = extensionApiRequest({
      extensionId,
      method,
      path,
      body
    })
    return {
      statusCode: Number(response.statusCode || 0),
      headers: Object.fromEntries(response.headers || []),
      body: response.body || ''
    }
  }
}

export const system = {
  now() {
    return Number(now().timestamp)
  },

  log(message, level = 'info') {
    log({level, message})
  }
}
