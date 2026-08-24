# OLX MCP Server

Why search for e-waste in your area by yourself if Claude can do it for you?

100% AI slop.

## Features

- 🌍 **Multi-Domain Support**: Search across 6 OLX domains (Brazil, Portugal, Poland, Bulgaria, Romania, Ukraine)
- 🔍 **Search Listings**: Search with filters for category, location, price range, and sorting
- 📋 **Listing Details**: Get detailed information about specific listings including seller info
- 🎭 **Browser Automation**: Reliable web scraping using Playwright

<img width="739" height="858" alt="Screenshot 2025-09-02 at 22 47 54" src="https://github.com/user-attachments/assets/c6fee7a4-fa84-4ca5-9eb0-7dc8a1ed6c58" />

## Installation

### 📋 Claude Desktop Configuration

1. **Locate your Claude Desktop config file:**

   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

2. **Add the OLX MCP server to your configuration:**

```json
{
  "mcpServers": {
    "olx-mcp": {
      "command": "npx",
      "args": ["olx-mcp"]
    }
  }
}
```

3. **Restart Claude Desktop** to load the new configuration.

### 🔄 Alternative: Global Installation

If you prefer to install globally:

```bash
npm install -g olx-mcp
```

Then use this config:
```json
{
  "mcpServers": {
    "olx-mcp": {
      "command": "olx-mcp"
    }
  }
}
```

### 📦 Development: From Source

```bash
git clone https://github.com/l-margiela/olx-mcp.git
cd olx-mcp
npm install
npm run build
```

Use this config for development:
```json
{
  "mcpServers": {
    "olx-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/olx-mcp/dist/index.js"]
    }
  }
}
```

## Usage

Once configured, you can use the following tools in your MCP client:

### Search Listings

Search for listings on any supported OLX domain with various filters:

```
Can you search for "apartments" in "Lisboa" on OLX Portugal with a maximum price of 1000 euros?
```

```
Search for "telefon" in "warszawa" on OLX Poland with prices between 100-500 PLN?
```

```
Procura "iphone 13" em São Paulo na OLX Brasil, entre R$ 500 e R$ 2000, mais baratos primeiro
```

**Parameters:**
- `domain` (required): OLX domain ('olx.com.br', 'olx.pt', 'olx.pl', 'olx.bg', 'olx.ro', 'olx.ua')
- `query` (optional): Search term
- `category` (optional): Category filter
- `location` (optional): Location filter
- `minPrice` (optional): Minimum price
- `maxPrice` (optional): Maximum price
- `page` (default: 1): Page number
- `limit` (default: 20): Items per page
- `sortBy` (default: 'relevance'): Sort order ('relevance', 'date', 'price-asc', 'price-desc')

### Listing Details

Get detailed information about a specific listing from any supported domain:

```
Can you get the details for listing "ABC123" from OLX Portugal?
```

```
Show me details for listing "XYZ789" from OLX Poland including images?
```

**Parameters:**
- `domain` (required): OLX domain ('olx.com.br', 'olx.pt', 'olx.pl', 'olx.bg', 'olx.ro', 'olx.ua')
- `listingId` (required): The ID of the listing — on olx.com.br this is the numeric id that ends
  every ad URL (`.../celulares/iphone-11-128gb-1528464732` → `1528464732`)
- `includeImages` (default: false): Include image URLs
- `includeSellerInfo` (default: true): Include seller information

## OLX Brazil (olx.com.br)

`olx.com.br` shares the brand but not the application. It is a separate Brazilian frontend, so it
is wired up differently from the European domains — worth knowing when passing filters.

### Categories and locations are site slugs, and order matters

A Brazilian search is addressed through the path, **category first, then location**:

```
https://www.olx.com.br/<category>/<state>/<region>?q=...
```

- `category` — a slug or slug path: `celulares`, `autos-e-pecas/carros-vans-e-utilitarios`
- `location` — a state (`SP` or `estado-sp`), a region (`sao-paulo-e-regiao`), or both
  (`estado-sp/sao-paulo-e-regiao`). A bare two-letter UF is expanded to `estado-<uf>` for you.

The order is not cosmetic: OLX silently ignores a category placed after a location, so
`/estado-sp/celulares` returns *every* São Paulo ad rather than only the phones. The server always
emits the working order.

### Results stop at page 100

Brazilian search caps out at 5.000 results. Requesting `page: 101` does not error on OLX's side —
it serves page 100 again — so the server refuses it outright rather than handing back duplicate
listings that look new. Narrow the search with a category, a location or a price range instead.

### `sortBy` changes *which* ads come back, not just their order

This is the surprising one, and it is the site's behaviour, not the scraper's. Applying any sort
makes OLX answer with a different result set:

| query (in `estado-rs`) | `relevance` | any sort (`sf=1`, `sp=1`, `sp=5`) |
| --- | --- | --- |
| `s22 ultra` | 71 results | 7 results |
| `galaxy s22 ultra 256gb` | 13 results | 7 results |
| `s22` | 21 results | 21 results |
| `ultra` | 352 results | **584 results** |

So a sort can narrow the set *or* widen it. The unsorted view appears to be a ranked, fuzzy match —
of those 71 `s22 ultra` hits, only 7 were actually S22 Ultras; the rest were S22, S22+, S21 Ultra,
S23 Ultra and accessories. The sorted view looks like it resolves the query to a product model and
returns only ads tagged with it, which would explain why three extra query words still yield the
same 7. That last part is inference, not something the site states.

What it means in practice: `totalCount` moves when you change `sortBy`, and asking for
`price-asc` to find the cheapest ad searches a *different corpus* than the default view — so it can
miss an ad the fuzzy match would have caught (a typo'd title, say). When you need the same ads a
person browsing the site sees, search with `relevance` and compare the prices yourself.

### Listing details come from structured data

Brazilian listing pages carry build-hashed class names, so there is nothing durable to select on.
Details are read from the page's schema.org `Product` block and its analytics payload instead, which
also means the reply carries a bit more than on the European domains: the ad's own attributes
(`Marca`, `Condição`, `Memória interna`, …), the full image list, and the publish timestamp.

Only three sort orders exist, each on its own URL parameter (`sf=1` for newest, `sp=1`/`sp=5` for
price). Anything else falls back to relevance, which is why the server sends only those.

## Development

### Scripts

- `npm run build` - Build the TypeScript project
- `npm run dev` - Run in development mode with hot reload
- `npm start` - Run the built server
- `npm test` - Run tests (when available)
- `npm run clean` - Clean build artifacts

## Troubleshooting

### MCP Inspector

For debugging MCP communication, you can use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT License - see LICENSE file for details.
