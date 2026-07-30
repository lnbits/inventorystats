import {extension, system} from './lnbits-sdk.js'

const INVENTORY_EXTENSION_ID = 'inventory'
const ITEM_PAGE_SIZE = 50
const LOG_PAGE_SIZE = 250
const MAX_ITEMS = 5000
const MAX_LOGS = 10000
const ALLOWED_PERIODS = new Set([0, 7, 30, 90, 365])

export function getInventoryStats(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const periodDays = normalizePeriod(request.days)
    const generatedAt = system.now()
    const inventory = getInventory()

    if (!inventory) {
      throw new Error(
        'No inventory was found. Create one in the Inventory extension first.'
      )
    }

    const itemPage = getInventoryItems(inventory.id)
    const logPage = getWebshopLogs(inventory.id, periodDays, generatedAt)
    const stats = buildStats({
      inventory,
      items: itemPage.data,
      logs: logPage.data,
      periodDays,
      generatedAt
    })

    stats.dataQuality = {
      itemCount: itemPage.data.length,
      itemTotal: itemPage.total,
      itemsTruncated: itemPage.truncated,
      salesLogCount: logPage.data.length,
      salesLogTotal: logPage.total,
      salesLogsTruncated: logPage.truncated
    }
    stats.warnings = dataWarnings(stats)

    system.log(
      `inventorystats: analysed ${itemPage.data.length} items and ${logPage.data.length} webshop stock movements`
    )
    return stats
  })
}

function getInventory() {
  const response = inventoryRequest('/api/v1')
  return parseResponse(response, 'Inventory')
}

function getInventoryItems(inventoryId) {
  return fetchPages({
    label: 'Inventory items',
    pageSize: ITEM_PAGE_SIZE,
    maximum: MAX_ITEMS,
    path(offset) {
      return `/api/v1/items/${encodeURIComponent(
        inventoryId
      )}/paginated?limit=${ITEM_PAGE_SIZE}&offset=${offset}&sortby=name&direction=asc`
    }
  })
}

function getWebshopLogs(inventoryId, periodDays, generatedAt) {
  const createdAfter =
    periodDays > 0
      ? new Date((generatedAt - periodDays * 86400) * 1000).toISOString()
      : ''

  return fetchPages({
    label: 'Inventory sales history',
    pageSize: LOG_PAGE_SIZE,
    maximum: MAX_LOGS,
    path(offset) {
      const filters = [
        `limit=${LOG_PAGE_SIZE}`,
        `offset=${offset}`,
        'sortby=created_at',
        'direction=asc',
        'source=webshop'
      ]
      if (createdAfter) {
        filters.push(`created_at[ge]=${encodeURIComponent(createdAfter)}`)
      }
      return `/api/v1/logs/${encodeURIComponent(
        inventoryId
      )}/paginated?${filters.join('&')}`
    }
  })
}

function fetchPages({label, pageSize, maximum, path}) {
  const data = []
  let total = 0

  while (data.length < maximum) {
    const response = inventoryRequest(path(data.length))
    const page = parseResponse(response, label)
    if (
      !page ||
      !Array.isArray(page.data) ||
      !Number.isFinite(Number(page.total))
    ) {
      throw new Error(`${label} returned an invalid paginated response.`)
    }

    const rows = page.data.slice(0, maximum - data.length)
    data.push(...rows)
    total = Math.max(0, Number(page.total))
    if (page.data.length < pageSize || data.length >= total) break
  }

  return {data, total, truncated: data.length < total}
}

function inventoryRequest(path) {
  return extension.request({
    extensionId: INVENTORY_EXTENSION_ID,
    method: 'GET',
    path
  })
}

function parseResponse(response, label) {
  if (response.statusCode !== 200) {
    if (response.statusCode === 404) {
      throw new Error(`${label} is unavailable. Check that Inventory is enabled.`)
    }
    throw new Error(`${label} returned HTTP ${response.statusCode}.`)
  }

  try {
    return JSON.parse(response.body || 'null')
  } catch {
    throw new Error(`${label} returned invalid JSON.`)
  }
}

function buildStats({inventory, items, logs, periodDays, generatedAt}) {
  const cleanItems = items.map(item => normalizeItem(item, inventory))
  const itemsById = new Map(cleanItems.map(item => [item.id, item]))
  const salesByItem = new Map()
  const trend = new Map()
  let earliestSaleAt = 0

  for (const log of logs) {
    const units = Math.max(0, -wholeNumber(log.quantity_change))
    if (units === 0) continue

    const item = itemsById.get(String(log.item_id || ''))
    const itemId = item ? item.id : String(log.item_id || 'unknown')
    const existing = salesByItem.get(itemId) || emptySale(itemId, item)
    existing.units += units
    existing.revenue += units * (item ? item.effectivePrice : 0)
    if (item && item.unitCost !== null) {
      existing.knownCost += units * item.unitCost
      existing.costedUnits += units
    }
    salesByItem.set(itemId, existing)

    const timestamp = dateTimestamp(log.created_at)
    if (timestamp && (!earliestSaleAt || timestamp < earliestSaleAt)) {
      earliestSaleAt = timestamp
    }
    const bucket = trendBucket(log.created_at, periodDays)
    const trendRow = trend.get(bucket) || {label: bucket, units: 0, revenue: 0}
    trendRow.units += units
    trendRow.revenue += units * (item ? item.effectivePrice : 0)
    trend.set(bucket, trendRow)
  }

  const observedDays =
    periodDays ||
    (earliestSaleAt
      ? Math.max(1, Math.ceil((generatedAt * 1000 - earliestSaleAt) / 86400000))
      : 1)
  const itemPerformance = cleanItems.map(item => {
    const sale = salesByItem.get(item.id) || emptySale(item.id, item)
    return performanceRow(item, sale, observedDays)
  })
  const deletedSales = [...salesByItem.values()]
    .filter(sale => !itemsById.has(sale.itemId))
    .map(sale => performanceRow(null, sale, observedDays))
  const allPerformance = [...itemPerformance, ...deletedSales]
  const soldPerformance = allPerformance
    .filter(row => row.unitsSold > 0)
    .sort(comparePerformance)
  const categoryPerformance = buildCategories(cleanItems, itemPerformance)
  const summary = buildSummary(cleanItems, soldPerformance)

  return {
    inventory: {
      id: String(inventory.id || ''),
      name: cleanText(inventory.name) || 'Inventory',
      currency: cleanText(inventory.currency).toUpperCase() || 'SAT'
    },
    generatedAt,
    period: {
      days: periodDays,
      observedDays,
      label: periodDays ? `Last ${periodDays} days` : 'All recorded history',
      trendGrain: periodDays === 365 || periodDays === 0 ? 'month' : 'day'
    },
    salesBasis: 'Paid webshop stock deductions',
    summary,
    trend: [...trend.values()].sort((a, b) => a.label.localeCompare(b.label)),
    topSellers: soldPerformance.slice(0, 10),
    stockLeaders: [...itemPerformance]
      .filter(row => row.quantityInStock !== null)
      .sort(
        (a, b) =>
          b.quantityInStock - a.quantityInStock ||
          a.name.localeCompare(b.name)
      )
      .slice(0, 10),
    categories: categoryPerformance,
    reorderWatch: itemPerformance
      .filter(row => row.needsReorder)
      .sort(
        (a, b) =>
          a.quantityInStock - b.quantityInStock ||
          b.unitsSold - a.unitsSold ||
          a.name.localeCompare(b.name)
      )
      .slice(0, 100),
    slowMovers: itemPerformance
      .filter(
        row =>
          row.quantityInStock > 0 &&
          row.unitsSold === 0 &&
          row.active &&
          row.approved
      )
      .sort(
        (a, b) =>
          b.retailValue - a.retailValue || a.name.localeCompare(b.name)
      )
      .slice(0, 20),
    abc: buildAbc(soldPerformance).slice(0, 100)
  }
}

function normalizeItem(item, inventory) {
  const quantity =
    item.quantity_in_stock === null || item.quantity_in_stock === undefined
      ? null
      : Math.max(0, wholeNumber(item.quantity_in_stock))
  const price = nonNegativeNumber(item.price)
  const unitCost =
    item.unit_cost === null || item.unit_cost === undefined
      ? null
      : nonNegativeNumber(item.unit_cost)
  const itemDiscount =
    item.discount_percentage === null ||
    item.discount_percentage === undefined
      ? numberOrNull(inventory.global_discount_percentage)
      : numberOrNull(item.discount_percentage)
  const discount = clamp(itemDiscount || 0, 0, 100)
  const tags = splitTags(item.tags)

  return {
    id: String(item.id || ''),
    name: cleanText(item.name) || 'Unnamed item',
    sku: cleanText(item.sku),
    quantity,
    price,
    effectivePrice: price * (1 - discount / 100),
    unitCost,
    reorderThreshold:
      item.reorder_threshold === null || item.reorder_threshold === undefined
        ? null
        : Math.max(0, wholeNumber(item.reorder_threshold)),
    category: tags[0] || 'Uncategorised',
    tags,
    active: item.is_active !== false,
    approved: item.is_approved !== false
  }
}

function emptySale(itemId, item) {
  return {
    itemId,
    itemName: item ? item.name : 'Deleted item',
    units: 0,
    revenue: 0,
    knownCost: 0,
    costedUnits: 0
  }
}

function performanceRow(item, sale, observedDays) {
  const quantity = item ? item.quantity : null
  const trackedQuantity = quantity === null ? 0 : quantity
  const unitCost = item ? item.unitCost : null
  const retailValue = item ? trackedQuantity * item.effectivePrice : 0
  const costValue =
    item && unitCost !== null ? trackedQuantity * unitCost : null
  const salesVelocity = sale.units / Math.max(1, observedDays)
  const sellThroughDenominator = sale.units + trackedQuantity
  const needsReorder =
    !!item &&
    item.active &&
    item.approved &&
    quantity !== null &&
    item.reorderThreshold !== null &&
    quantity <= item.reorderThreshold

  return {
    id: item ? item.id : sale.itemId,
    name: item ? item.name : sale.itemName,
    sku: item ? item.sku : '',
    category: item ? item.category : 'Deleted item',
    quantityInStock: quantity,
    reorderThreshold: item ? item.reorderThreshold : null,
    active: item ? item.active : false,
    approved: item ? item.approved : false,
    unitsSold: sale.units,
    estimatedRevenue: roundMoney(sale.revenue),
    estimatedGrossProfit:
      sale.costedUnits === sale.units
        ? roundMoney(sale.revenue - sale.knownCost)
        : null,
    salesVelocity: roundNumber(salesVelocity, 3),
    daysOfCover:
      quantity !== null && salesVelocity > 0
        ? roundNumber(quantity / salesVelocity, 1)
        : null,
    sellThrough:
      sellThroughDenominator > 0
        ? roundNumber((sale.units / sellThroughDenominator) * 100, 1)
        : 0,
    retailValue: roundMoney(retailValue),
    costValue: costValue === null ? null : roundMoney(costValue),
    needsReorder
  }
}

function buildSummary(items, soldPerformance) {
  const tracked = items.filter(item => item.quantity !== null)
  const stockUnits = tracked.reduce((total, item) => total + item.quantity, 0)
  const retailValue = tracked.reduce(
    (total, item) => total + item.quantity * item.effectivePrice,
    0
  )
  const costed = tracked.filter(item => item.unitCost !== null)
  const knownCostValue = costed.reduce(
    (total, item) => total + item.quantity * item.unitCost,
    0
  )
  const retailValueOfCosted = costed.reduce(
    (total, item) => total + item.quantity * item.effectivePrice,
    0
  )
  const unitsSold = soldPerformance.reduce(
    (total, item) => total + item.unitsSold,
    0
  )
  const estimatedRevenue = soldPerformance.reduce(
    (total, item) => total + item.estimatedRevenue,
    0
  )
  const knownProfitRows = soldPerformance.filter(
    item => item.estimatedGrossProfit !== null
  )
  const estimatedGrossProfit = knownProfitRows.reduce(
    (total, item) => total + item.estimatedGrossProfit,
    0
  )
  const sellThroughDenominator = unitsSold + stockUnits

  return {
    itemCount: items.length,
    activeItemCount: items.filter(item => item.active && item.approved).length,
    pendingItemCount: items.filter(item => !item.approved).length,
    inactiveItemCount: items.filter(item => !item.active).length,
    trackedItemCount: tracked.length,
    untrackedItemCount: items.length - tracked.length,
    stockUnits,
    retailValue: roundMoney(retailValue),
    knownCostValue: roundMoney(knownCostValue),
    costCoverage:
      tracked.length > 0
        ? roundNumber((costed.length / tracked.length) * 100, 1)
        : 0,
    potentialGrossProfit: roundMoney(retailValueOfCosted - knownCostValue),
    outOfStockCount: items.filter(
      item => item.active && item.approved && item.quantity === 0
    ).length,
    lowStockCount: items.filter(
      item =>
        item.active &&
        item.approved &&
        item.quantity !== null &&
        item.reorderThreshold !== null &&
        item.quantity <= item.reorderThreshold
    ).length,
    unitsSold,
    estimatedRevenue: roundMoney(estimatedRevenue),
    estimatedGrossProfit: roundMoney(estimatedGrossProfit),
    profitCoverage:
      soldPerformance.length > 0
        ? roundNumber(
            (knownProfitRows.length / soldPerformance.length) * 100,
            1
          )
        : 0,
    sellThrough:
      sellThroughDenominator > 0
        ? roundNumber((unitsSold / sellThroughDenominator) * 100, 1)
        : 0
  }
}

function buildCategories(items, itemPerformance) {
  const categories = new Map()
  const performanceById = new Map(
    itemPerformance.map(performance => [performance.id, performance])
  )

  for (const item of items) {
    const row = categories.get(item.category) || {
      name: item.category,
      itemCount: 0,
      stockUnits: 0,
      retailValue: 0,
      unitsSold: 0,
      estimatedRevenue: 0,
      lowStockCount: 0
    }
    const performance = performanceById.get(item.id)
    row.itemCount += 1
    row.stockUnits += item.quantity || 0
    row.retailValue += performance.retailValue
    row.unitsSold += performance.unitsSold
    row.estimatedRevenue += performance.estimatedRevenue
    if (performance.needsReorder) row.lowStockCount += 1
    categories.set(item.category, row)
  }

  const rows = [...categories.values()]
    .map(row => ({
      ...row,
      retailValue: roundMoney(row.retailValue),
      estimatedRevenue: roundMoney(row.estimatedRevenue)
    }))
    .sort(
      (a, b) =>
        b.retailValue - a.retailValue ||
        b.unitsSold - a.unitsSold ||
        a.name.localeCompare(b.name)
    )

  if (rows.length <= 20) return rows

  const other = rows.slice(19).reduce(
    (total, row) => ({
      name: 'Other categories',
      itemCount: total.itemCount + row.itemCount,
      stockUnits: total.stockUnits + row.stockUnits,
      retailValue: total.retailValue + row.retailValue,
      unitsSold: total.unitsSold + row.unitsSold,
      estimatedRevenue: total.estimatedRevenue + row.estimatedRevenue,
      lowStockCount: total.lowStockCount + row.lowStockCount
    }),
    {
      name: 'Other categories',
      itemCount: 0,
      stockUnits: 0,
      retailValue: 0,
      unitsSold: 0,
      estimatedRevenue: 0,
      lowStockCount: 0
    }
  )
  return [...rows.slice(0, 19), other]
}

function buildAbc(soldPerformance) {
  const totalRevenue = soldPerformance.reduce(
    (total, item) => total + item.estimatedRevenue,
    0
  )
  let cumulative = 0

  return soldPerformance.map(item => {
    const share =
      totalRevenue > 0 ? (item.estimatedRevenue / totalRevenue) * 100 : 0
    const grade = cumulative < 80 ? 'A' : cumulative < 95 ? 'B' : 'C'
    cumulative += share
    return {
      ...item,
      grade,
      revenueShare: roundNumber(share, 1),
      cumulativeRevenueShare: roundNumber(cumulative, 1)
    }
  })
}

function dataWarnings(stats) {
  const warnings = []
  if (stats.dataQuality.itemsTruncated) {
    warnings.push(
      `Only ${stats.dataQuality.itemCount} of ${stats.dataQuality.itemTotal} items were analysed.`
    )
  }
  if (stats.dataQuality.salesLogsTruncated) {
    warnings.push(
      `Only ${stats.dataQuality.salesLogCount} of ${stats.dataQuality.salesLogTotal} sales movements were analysed.`
    )
  }
  if (stats.summary.untrackedItemCount) {
    warnings.push(
      `${stats.summary.untrackedItemCount} item(s) have no tracked stock quantity.`
    )
  }
  if (stats.summary.costCoverage < 100) {
    warnings.push(
      `Cost and margin figures cover ${stats.summary.costCoverage}% of tracked item records.`
    )
  }
  if (stats.summary.lowStockCount > stats.reorderWatch.length) {
    warnings.push(
      `The reorder table shows the first ${stats.reorderWatch.length} of ${stats.summary.lowStockCount} low-stock items.`
    )
  }
  return warnings
}

function comparePerformance(a, b) {
  return (
    b.unitsSold - a.unitsSold ||
    b.estimatedRevenue - a.estimatedRevenue ||
    a.name.localeCompare(b.name)
  )
}

function trendBucket(value, periodDays) {
  const timestamp = dateTimestamp(value)
  if (!timestamp) return 'Unknown'
  const iso = new Date(timestamp).toISOString()
  return periodDays === 365 || periodDays === 0 ? iso.slice(0, 7) : iso.slice(0, 10)
}

function dateTimestamp(value) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

function splitTags(value) {
  return String(value || '')
    .split(',')
    .map(tag => cleanText(tag))
    .filter(Boolean)
}

function normalizePeriod(value) {
  const days = wholeNumber(value)
  return ALLOWED_PERIODS.has(days) ? days : 30
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = JSON.parse(value)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Request must be a JSON object.')
  }
  return parsed
}

function cleanText(value) {
  return String(value || '').trim()
}

function wholeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegativeNumber(value) {
  return Math.max(0, numberOrNull(value) || 0)
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function roundMoney(value) {
  return roundNumber(value, 2)
}

function roundNumber(value, digits) {
  const factor = 10 ** digits
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    system.log(`inventorystats: ${message}`, 'error')
    return JSON.stringify({ok: false, error: message})
  }
}
