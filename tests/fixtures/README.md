# Fixtures

Drop real HTML here to test the parsers offline, without spending ScrapingBee
credits or sending requests to CompanyWall.

Name files by prefix so `npm test` knows which parser to run:

| Prefix       | Parser               | Where to get it                                    |
| ------------ | -------------------- | -------------------------------------------------- |
| `search-*`   | `parseSearchResults` | a `/prebaruvanje?...` results page                  |
| `profile-*`  | `parseProfile`       | a `/kompanija/{slug}/{code}` page                   |
| `lica-*`     | `parseLica`          | a `/kompanija/{slug}/{code}/lica` page              |

Example: `search-r7-p1.html`, `profile-alfa.html`, `lica-alfa.html`.

## Getting the HTML

Run workflow `00-step0-recon.json`, open the `Diagnose` node output, and copy
the response body. Or save the page from a browser — but prefer the ScrapingBee
response, since that is what the workflow will actually parse.

## Tuning loop

```
save HTML here  ->  npm test  ->  read the "Real fixtures" report
      ^                                      |
      +-------- edit lib/parsers.js ---------+

then: npm run build   # regenerate workflows, re-import into n8n
```

`npm test` prints what each parser extracted from every fixture, and warns when
a search page has many rows missing ЕДБ (which means row chunking is off).

Fixtures are not committed — this directory is gitignored apart from this file,
since scraped pages contain third-party business data.
