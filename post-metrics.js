name: Post BTC/BSV Metrics (Manual)

on:
  workflow_dispatch: {}

jobs:
  post:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Preflight
        run: npm run preflight
        env:
          DRY_RUN:          ${{ vars.DRY_RUN || '1' }}
          EXPLAINER_URL:    ${{ vars.EXPLAINER_URL }}
          BTC_TIER:         ${{ vars.BTC_TIER }}

      - name: Post metrics (DRY_RUN respected)
        env:
          X_APP_KEY:        ${{ secrets.X_APP_KEY }}
          X_APP_SECRET:     ${{ secrets.X_APP_SECRET }}
          X_ACCESS_TOKEN:   ${{ secrets.X_ACCESS_TOKEN }}
          X_ACCESS_SECRET:  ${{ secrets.X_ACCESS_SECRET }}
          EXPLAINER_URL:    ${{ vars.EXPLAINER_URL }}
          BTC_TIER:         ${{ vars.BTC_TIER }}
          DRY_RUN:          ${{ vars.DRY_RUN || '1' }}
        run: node post-metrics.js
