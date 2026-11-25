import assertModule from 'assert'
import {component} from './component.mjs'

const assert = assertModule.strict
const tests = []

function test(name, fn) {
  tests.push({name, fn})
}

async function moduleWithInventory(overrides = {}) {
  const inventory =
    overrides.inventory === undefined
      ? {
          id: 'inventory_1',
          name: 'Demo shop',
          currency: 'USD',
          global_discount_percentage: 0
        }
      : overrides.inventory
  const items = overrides.items || [
    {
      id: 'coffee',
      name: 'Coffee',
      sku: 'COF',
      quantity_in_stock: 5,
      price: 10,
      discount_percentage: 10,
      unit_cost: 4,
      reorder_threshold: 5,
      tags: 'Drinks,Hot',
      is_active: true,
      is_approved: true
    },
    {
      id: 'tea',
      name: 'Tea',
      sku: 'TEA',
      quantity_in_stock: 0,
      price: 5,
      discount_percentage: null,
      unit_cost: 2,
      reorder_threshold: 2,
      tags: 'Drinks',
      is_active: true,
      is_approved: true
    },
    {
      id: 'mug',
      name: 'Mug',
      sku: 'MUG',
      quantity_in_stock: 20,
      price: 12,
      discount_percentage: null,
      unit_cost: null,
      reorder_threshold: 5,
      tags: 'Merch',
      is_active: true,
      is_approved: true
    },
    {
      id: 'service',
      name: 'Workshop',
      quantity_in_stock: null,
      price: 100,
      unit_cost: null,
      reorder_threshold: null,
      tags: '',
      is_active: true,
      is_approved: true
    }
  ]
  const logs = overrides.logs || [
    {
      item_id: 'coffee',
      quantity_change: -3,
      source: 'webshop',
      created_at: '2025-05-30T10:00:00Z'
    },
    {
      item_id: 'coffee',
      quantity_change: -2,
      source: 'webshop',
      created_at: '2025-05-31T10:00:00Z'
    },
    {
      item_id: 'tea',
      quantity_change: -1,
      source: 'webshop',
      created_at: '2025-05-31T12:00:00Z'
    },
    {
      item_id: 'coffee',
      quantity_change: -99,
      source: 'manual',
      created_at: '2025-05-31T13:00:00Z'
    }
  ]
  const requests = []
  const logMessages = []
  const extension = {
    request({extensionId, method, path}) {
      requests.push({extensionId, method, path})
      assert.equal(extensionId, 'inventory')
      assert.equal(method, 'GET')
      const url = new URL(path, 'http://inventory.local')

      if (url.pathname === '/api/v1') {
        return response(inventory)
      }
      if (url.pathname.includes('/items/')) {
        return response(page(items, url))
      }
      if (url.pathname.includes('/logs/')) {
        let filtered = logs.filter(log => log.source === url.searchParams.get('source'))
        const createdAfter = url.searchParams.get('created_at[ge]')
        if (createdAfter) {
          filtered = filtered.filter(
            log => Date.parse(log.created_at) >= Date.parse(createdAfter)
          )
        }
        return response(page(filtered, url))
      }
      return {statusCode: 404, headers: {}, body: ''}
    }
  }
  const system = {
    now() {
      return 1_748_736_000 // 2025-06-01T00:00:00Z
    },
    log(message, level = 'info') {
      logMessages.push({message, level})
    }
  }

  const api = component({
    'lnbits:extension/host': {
      extensionApiRequest(request) {
        return {...extension.request(request), headers: []}
      },
      now: () => ({timestamp: BigInt(system.now())}),
      log({message, level}) {
        system.log(message, level)
        return {ok: true}
      }
    }
  })

  return {api, requests, logMessages}
}

function response(value) {
  return {statusCode: 200, headers: {}, body: JSON.stringify(value)}
}

function page(rows, url) {
  const offset = Number(url.searchParams.get('offset') || 0)
  const limit = Number(url.searchParams.get('limit') || 10)
  return {data: rows.slice(offset, offset + limit), total: rows.length}
}

function unwrap(value) {
  return JSON.parse(value)
}

function ok(value) {
  const response = unwrap(value)
  assert.equal(response.ok, true, response.error)
  return response.data
}

test('calculates stock health and webshop sales metrics', async () => {
  const {api} = await moduleWithInventory()
  const stats = ok(api.getInventoryStats(JSON.stringify({days: 30})))

  assert.equal(stats.inventory.name, 'Demo shop')
  assert.equal(stats.summary.itemCount, 4)
  assert.equal(stats.summary.stockUnits, 25)
  assert.equal(stats.summary.retailValue, 285)
  assert.equal(stats.summary.knownCostValue, 20)
  assert.equal(stats.summary.lowStockCount, 2)
  assert.equal(stats.summary.outOfStockCount, 1)
  assert.equal(stats.summary.untrackedItemCount, 1)

  assert.equal(stats.summary.unitsSold, 6)
  assert.equal(stats.summary.estimatedRevenue, 50)
  assert.equal(stats.topSellers[0].id, 'coffee')
  assert.equal(stats.topSellers[0].unitsSold, 5)
  assert.equal(stats.topSellers[0].sellThrough, 50)
  assert.equal(stats.reorderWatch.length, 2)
  assert.equal(stats.slowMovers[0].id, 'mug')
})

test('groups by primary tag and grades products by estimated revenue', async () => {
  const {api} = await moduleWithInventory()
  const stats = ok(api.getInventoryStats(JSON.stringify({days: 30})))
  const drinks = stats.categories.find(category => category.name === 'Drinks')

  assert.equal(drinks.itemCount, 2)
  assert.equal(drinks.stockUnits, 5)
  assert.equal(drinks.unitsSold, 6)
  assert.deepEqual(
    stats.abc.map(item => [item.id, item.grade]),
    [
      ['coffee', 'A'],
      ['tea', 'B']
    ]
  )
})

test('requests only webshop logs inside the selected period', async () => {
  const {api, requests} = await moduleWithInventory()
  ok(api.getInventoryStats(JSON.stringify({days: 7})))

  const logRequest = requests.find(request => request.path.includes('/logs/'))
  const url = new URL(logRequest.path, 'http://inventory.local')
  assert.equal(url.searchParams.get('source'), 'webshop')
  assert.equal(url.searchParams.get('created_at[ge]'), '2025-05-25T00:00:00.000Z')
})

test('reports a useful error when no inventory exists', async () => {
  const {api, logMessages} = await moduleWithInventory({inventory: null})
  const result = unwrap(api.getInventoryStats(JSON.stringify({days: 30})))

  assert.equal(result.ok, false)
  assert.match(result.error, /No inventory was found/)
  assert.equal(logMessages.at(-1).level, 'error')
})

let failures = 0
for (const entry of tests) {
  try {
    await entry.fn()
    process.stdout.write(`ok - ${entry.name}\n`)
  } catch (error) {
    failures += 1
    process.stderr.write(`not ok - ${entry.name}\n${error.stack}\n`)
  }
}

if (failures) process.exitCode = 1
