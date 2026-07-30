const client = window.createLNbitsExtensionClient({
  extensionId: 'inventorystats'
})

const app = Vue.createApp({
  data() {
    return {
      loading: false,
      error: '',
      stats: null,
      days: 30,
      periodOptions: [
        {label: 'Last 7 days', value: 7},
        {label: 'Last 30 days', value: 30},
        {label: 'Last 90 days', value: 90},
        {label: 'Last 12 months', value: 365},
        {label: 'All history', value: 0}
      ]
    }
  },

  async mounted() {
    await this.loadStats()
  },

  methods: {
    async loadStats() {
      if (this.loading) return
      this.loading = true
      this.error = ''
      try {
        this.stats = await client.getStats(this.days)
      } catch (error) {
        this.stats = null
        this.error = error instanceof Error ? error.message : String(error)
        client.notifyError(this.error).catch(() => {})
      } finally {
        this.loading = false
      }
    },

    async changePeriod(event) {
      this.days = Number(event.target.value)
      await this.loadStats()
    },

    number(value, digits = 0) {
      const number = Number(value || 0)
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: digits
      }).format(number)
    },

    money(value) {
      const amount = Number(value || 0)
      const currency = this.stats?.inventory?.currency || 'SAT'
      if (currency === 'SAT' || currency === 'SATS') {
        return `${this.number(amount, 0)} sats`
      }
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
          maximumFractionDigits: 2
        }).format(amount)
      } catch {
        return `${this.number(amount, 2)} ${currency}`
      }
    },

    percent(value) {
      return `${this.number(value, 1)}%`
    },

    compact(value) {
      return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1
      }).format(Number(value || 0))
    },

    barPercent(value, maximum) {
      if (!maximum || Number(value) <= 0) return 0
      return Math.max(3, (Number(value) / maximum) * 100)
    },

    trendPoints(rows) {
      if (!rows.length) return ''
      const width = 600
      const height = 180
      const maximum = Math.max(...rows.map(row => Number(row.units || 0)), 1)
      return rows
        .map((row, index) => {
          const x = rows.length === 1 ? width / 2 : (index / (rows.length - 1)) * width
          const y = height - (Number(row.units || 0) / maximum) * (height - 20) - 10
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
    }
  },

  render() {
    const h = Vue.h
    const QBtn = Vue.resolveComponent('q-btn')
    const QSpinner = Vue.resolveComponent('q-spinner')

    const button = (label, icon, props = {}) =>
      h(
        QBtn,
        {
          unelevated: true,
          noCaps: true,
          icon,
          label,
          ...props
        }
      )

    const metricCard = (label, value, caption, tone = '') =>
      h('article', {class: `metric-card ${tone}`}, [
        h('div', {class: 'metric-label'}, label),
        h('div', {class: 'metric-value'}, value),
        h('div', {class: 'metric-caption'}, caption)
      ])

    const sectionHeader = (title, subtitle) =>
      h('header', {class: 'section-header'}, [
        h('div', [
          h('h2', title),
          subtitle ? h('p', {class: 'muted'}, subtitle) : null
        ])
      ])

    const emptyState = message =>
      h('div', {class: 'empty-state'}, [
        h('span', {class: 'material-icons'}, 'query_stats'),
        h('p', message)
      ])

    const horizontalBars = ({
      rows,
      value,
      format,
      detail,
      className = 'primary'
    }) => {
      if (!rows.length) return emptyState('No data for this period yet.')
      const maximum = Math.max(...rows.map(row => Number(row[value] || 0)), 0)
      return h(
        'div',
        {class: 'bar-list'},
        rows.map(row =>
          h('div', {class: 'bar-row', key: `${row.id || row.name}-${value}`}, [
            h('div', {class: 'bar-label-row'}, [
              h('span', {class: 'bar-label', title: row.name}, row.name),
              h('strong', format(row[value]))
            ]),
            h('svg', {class: 'bar-track', viewBox: '0 0 100 7'}, [
              h('rect', {
                class: 'bar-background',
                x: 0,
                y: 0,
                width: 100,
                height: 7,
                rx: 3.5
              }),
              h('rect', {
                class: `bar-fill ${className}`,
                x: 0,
                y: 0,
                width: this.barPercent(row[value], maximum),
                height: 7,
                rx: 3.5
              })
            ]),
            detail ? h('div', {class: 'bar-detail'}, detail(row)) : null
          ])
        )
      )
    }

    const table = (columns, rows, rowKey = 'id') =>
      h('div', {class: 'table-scroll'}, [
        h('table', {class: 'stats-table'}, [
          h(
            'thead',
            h(
              'tr',
              columns.map(column =>
                h(
                  'th',
                  {class: column.align === 'right' ? 'text-right' : ''},
                  column.label
                )
              )
            )
          ),
          h(
            'tbody',
            rows.map(row =>
              h(
                'tr',
                {key: row[rowKey]},
                columns.map(column =>
                  h(
                    'td',
                    {class: column.align === 'right' ? 'text-right' : ''},
                    column.render(row)
                  )
                )
              )
            )
          )
        ])
      ])

    const shellHeader = h('header', {class: 'dashboard-header'}, [
      h('div', {class: 'brand'}, [
        h('img', {
          src: '/ext-assets/inventorystats/assets/icon.svg',
          alt: '',
          class: 'brand-icon'
        }),
        h('div', [
          h('div', {class: 'eyebrow'}, 'INVENTORY INTELLIGENCE'),
          h('h1', this.stats?.inventory?.name || 'InventoryStats'),
          h(
            'p',
            {class: 'muted'},
            'See what moves, what needs attention, and where your stock value sits.'
          )
        ])
      ]),
      h('div', {class: 'header-actions'}, [
        h('label', {class: 'period-field'}, [
          h('span', 'Reporting period'),
          h(
            'select',
            {
              value: this.days,
              disabled: this.loading,
              onChange: this.changePeriod
            },
            this.periodOptions.map(option =>
              h(
                'option',
                {value: option.value, key: option.value},
                option.label
              )
            )
          )
        ]),
        button('Refresh', 'refresh', {
          color: 'primary',
          loading: this.loading,
          onClick: this.loadStats
        })
      ])
    ])

    if (this.loading && !this.stats) {
      return h('main', {class: 'shell'}, [
        shellHeader,
        h('div', {class: 'loading-state'}, [
          h(QSpinner, {color: 'primary', class: 'loading-spinner'}),
          h('p', 'Reading Inventory items and stock history…')
        ])
      ])
    }

    if (this.error) {
      return h('main', {class: 'shell'}, [
        shellHeader,
        h('section', {class: 'error-state'}, [
          h('span', {class: 'material-icons'}, 'inventory_2'),
          h('h2', 'Inventory data is unavailable'),
          h('p', this.error),
          h(
            'p',
            {class: 'muted'},
            'InventoryStats needs the Inventory extension installed, enabled, and populated for this account.'
          ),
          button('Try again', 'refresh', {
            color: 'primary',
            onClick: this.loadStats
          })
        ])
      ])
    }

    if (!this.stats) return h('main', {class: 'shell'}, [shellHeader])

    const {summary} = this.stats
    const maxCategoryValue = Math.max(
      ...this.stats.categories.map(category => category.retailValue),
      0
    )
    const maxCategorySales = Math.max(
      ...this.stats.categories.map(category => category.unitsSold),
      0
    )
    const reorderColumns = [
      {
        label: 'Item',
        render: item =>
          h('div', [
            h('strong', item.name),
            h(
              'div',
              {class: 'table-subtitle'},
              [item.sku, item.category].filter(Boolean).join(' · ')
            )
          ])
      },
      {
        label: 'Stock',
        align: 'right',
        render: item =>
          h(
            'span',
            {class: item.quantityInStock === 0 ? 'text-negative' : ''},
            this.number(item.quantityInStock)
          )
      },
      {
        label: 'Threshold',
        align: 'right',
        render: item => this.number(item.reorderThreshold)
      },
      {
        label: 'Sold',
        align: 'right',
        render: item => this.number(item.unitsSold)
      },
      {
        label: 'Velocity / day',
        align: 'right',
        render: item => this.number(item.salesVelocity, 2)
      },
      {
        label: 'Days cover',
        align: 'right',
        render: item =>
          item.daysOfCover === null ? '—' : this.number(item.daysOfCover, 1)
      }
    ]
    const abcColumns = [
      {
        label: 'Grade',
        render: item =>
          h('span', {class: `grade grade-${item.grade.toLowerCase()}`}, item.grade)
      },
      {
        label: 'Item',
        render: item => item.name
      },
      {
        label: 'Units sold',
        align: 'right',
        render: item => this.number(item.unitsSold)
      },
      {
        label: 'Est. revenue',
        align: 'right',
        render: item => this.money(item.estimatedRevenue)
      },
      {
        label: 'Revenue share',
        align: 'right',
        render: item => this.percent(item.revenueShare)
      },
      {
        label: 'Stock',
        align: 'right',
        render: item =>
          item.quantityInStock === null
            ? 'Untracked'
            : this.number(item.quantityInStock)
      }
    ]

    return h('main', {class: 'shell'}, [
      shellHeader,
      this.stats.warnings.length
        ? h(
            'section',
            {class: 'warning-strip'},
            this.stats.warnings.map(warning =>
              h('div', {key: warning}, [
                h('span', {class: 'material-icons'}, 'info'),
                h('span', warning)
              ])
            )
          )
        : null,
      h('section', {class: 'metric-grid'}, [
        metricCard(
          'Items',
          this.number(summary.itemCount),
          `${summary.activeItemCount} active · ${summary.pendingItemCount} pending`
        ),
        metricCard(
          'Units on hand',
          this.number(summary.stockUnits),
          `${summary.trackedItemCount} tracked items`
        ),
        metricCard(
          'Retail value',
          this.money(summary.retailValue),
          'At current effective prices'
        ),
        metricCard(
          'Known stock cost',
          this.money(summary.knownCostValue),
          `${this.money(
            summary.potentialGrossProfit
          )} potential margin · ${this.percent(summary.costCoverage)} coverage`
        ),
        metricCard(
          'Units sold',
          this.number(summary.unitsSold),
          this.stats.period.label,
          'sales'
        ),
        metricCard(
          'Estimated revenue',
          this.money(summary.estimatedRevenue),
          summary.profitCoverage
            ? `${this.money(summary.estimatedGrossProfit)} est. gross profit`
            : 'Current effective prices',
          'sales'
        ),
        metricCard(
          'Sell-through',
          this.percent(summary.sellThrough),
          'Sold ÷ sold plus on hand',
          'sales'
        ),
        metricCard(
          'Needs attention',
          this.number(summary.lowStockCount),
          `${summary.outOfStockCount} out · ${summary.untrackedItemCount} untracked`,
          summary.lowStockCount ? 'attention' : ''
        )
      ]),
      h('section', {class: 'dashboard-grid'}, [
        h('article', {class: 'panel span-7'}, [
          sectionHeader(
            'Best sellers',
            `${this.stats.salesBasis} · ranked by units`
          ),
          horizontalBars({
            rows: this.stats.topSellers,
            value: 'unitsSold',
            format: value => `${this.number(value)} sold`,
            detail: item =>
              `${this.money(item.estimatedRevenue)} est. revenue · ${this.percent(
                item.sellThrough
              )} sell-through`,
            className: 'sales'
          })
        ]),
        h('article', {class: 'panel span-5'}, [
          sectionHeader(
            'Sales activity',
            `${this.stats.period.trendGrain === 'month' ? 'Monthly' : 'Daily'} units sold`
          ),
          this.stats.trend.length
            ? h('div', {class: 'trend-chart'}, [
                h(
                  'svg',
                  {
                    viewBox: '0 0 600 200',
                    preserveAspectRatio: 'none',
                    role: 'img',
                    'aria-label': 'Units sold over time'
                  },
                  [
                    h('line', {
                      x1: 0,
                      y1: 190,
                      x2: 600,
                      y2: 190,
                      class: 'chart-grid-line'
                    }),
                    h('polyline', {
                      points: this.trendPoints(this.stats.trend),
                      class: 'trend-shadow'
                    }),
                    h('polyline', {
                      points: this.trendPoints(this.stats.trend),
                      class: 'trend-line'
                    })
                  ]
                ),
                h('div', {class: 'trend-axis'}, [
                  h('span', this.stats.trend[0].label),
                  h(
                    'strong',
                    `${this.number(summary.unitsSold)} total units`
                  ),
                  h(
                    'span',
                    this.stats.trend[this.stats.trend.length - 1].label
                  )
                ])
              ])
            : emptyState('No webshop sales were recorded in this period.')
        ]),
        h('article', {class: 'panel span-7'}, [
          sectionHeader(
            'Category mix',
            'The first item tag is treated as its primary category.'
          ),
          this.stats.categories.length
            ? h(
                'div',
                {class: 'category-list'},
                this.stats.categories.map(category =>
                  h('div', {class: 'category-row', key: category.name}, [
                    h('div', {class: 'category-heading'}, [
                      h('strong', category.name),
                      h(
                        'span',
                        `${category.itemCount} item${
                          category.itemCount === 1 ? '' : 's'
                        }`
                      )
                    ]),
                    h('div', {class: 'category-metric'}, [
                      h('span', 'Stock value'),
                      h('svg', {class: 'bar-track', viewBox: '0 0 100 7'}, [
                        h('rect', {
                          class: 'bar-background',
                          x: 0,
                          y: 0,
                          width: 100,
                          height: 7,
                          rx: 3.5
                        }),
                        h('rect', {
                          class: 'bar-fill primary',
                          x: 0,
                          y: 0,
                          width: this.barPercent(
                            category.retailValue,
                            maxCategoryValue
                          ),
                          height: 7,
                          rx: 3.5
                        })
                      ]),
                      h('strong', this.money(category.retailValue))
                    ]),
                    h('div', {class: 'category-metric'}, [
                      h('span', 'Units sold'),
                      h('svg', {class: 'bar-track', viewBox: '0 0 100 7'}, [
                        h('rect', {
                          class: 'bar-background',
                          x: 0,
                          y: 0,
                          width: 100,
                          height: 7,
                          rx: 3.5
                        }),
                        h('rect', {
                          class: 'bar-fill sales',
                          x: 0,
                          y: 0,
                          width: this.barPercent(
                            category.unitsSold,
                            maxCategorySales
                          ),
                          height: 7,
                          rx: 3.5
                        })
                      ]),
                      h('strong', this.number(category.unitsSold))
                    ])
                  ])
                )
              )
            : emptyState('Add tags to Inventory items to compare categories.')
        ]),
        h('article', {class: 'panel span-5'}, [
          sectionHeader('Stock concentration', 'Items with the most units on hand.'),
          horizontalBars({
            rows: this.stats.stockLeaders,
            value: 'quantityInStock',
            format: value => this.number(value),
            detail: item => `${this.money(item.retailValue)} retail value`
          })
        ])
      ]),
      h('section', {class: 'panel table-panel'}, [
        sectionHeader(
          'Reorder watch',
          'Active items at or below their configured reorder threshold.'
        ),
        this.stats.reorderWatch.length
          ? table(reorderColumns, this.stats.reorderWatch)
          : emptyState('No tracked item is currently below its reorder threshold.')
      ]),
      h('section', {class: 'dashboard-grid lower-grid'}, [
        h('article', {class: 'panel span-7'}, [
          sectionHeader(
            'ABC product analysis',
            'A items drive the first 80% of estimated revenue, B the next 15%, and C the remainder.'
          ),
          this.stats.abc.length
            ? table(abcColumns, this.stats.abc.slice(0, 20))
            : emptyState('ABC grades appear after webshop sales are recorded.')
        ]),
        h('article', {class: 'panel span-5'}, [
          sectionHeader(
            'Slow movers',
            `Active stock with no webshop sales in ${this.stats.period.label.toLowerCase()}.`
          ),
          horizontalBars({
            rows: this.stats.slowMovers.slice(0, 10),
            value: 'retailValue',
            format: value => this.money(value),
            detail: item => `${this.number(item.quantityInStock)} units on hand`,
            className: 'warning'
          })
        ])
      ]),
      h('footer', {class: 'method-note'}, [
        h('span', {class: 'material-icons'}, 'calculate'),
        h('div', [
          h('strong', 'How to read these figures'),
          h(
            'p',
            `Sales count negative Inventory stock movements marked “webshop”. Revenue, gross profit, and ABC grades are estimates using current effective prices${
              summary.profitCoverage < 100
                ? `; profit covers ${this.percent(summary.profitCoverage)} of sold item records with unit costs`
                : ''
            }. Manual stock reductions are intentionally excluded.`
          )
        ])
      ])
    ])
  }
})

app.use(Quasar)
app.mount('#inventorystats-app')
