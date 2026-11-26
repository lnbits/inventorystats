# InventoryStats

InventoryStats is a read-only WASM companion for the LNbits Inventory extension.
It turns Inventory items and webshop stock-deduction logs into an operational
dashboard.

## Reports

- Stock on hand, retail value, known cost value, and potential margin
- Low-stock, out-of-stock, untracked, inactive, and pending-item health
- Best sellers, sales velocity, sell-through, and sales activity over time
- Stock and sales grouped by an item's first tag (its primary category)
- Reorder watch list, slow movers, and ABC product analysis

Sales figures use Inventory audit entries whose source is `webshop`. Revenue and
profit are estimates based on the item's current effective price and unit cost
because Inventory logs stock movement rather than historical checkout prices.

## Installation

Place the extension directory under the server's configured
`LNBITS_WASM_EXTENSIONS_PATH`, restart LNbits, and enable InventoryStats for the
same account that uses Inventory. InventoryStats requests read-only access to
the Inventory API during installation.

## Development

From `dev/`:

```sh
rustup target add wasm32-wasip2
npm run build
npm run check
```

Cargo builds the Rust guest for the WASI component target and writes
`wasm/module.wasm`.
