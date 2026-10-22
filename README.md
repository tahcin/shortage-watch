# Shortage Watch

Shortage Watch is an agent that tells a hospital pharmacy buyer which drugs are about to run short, why, and what to order instead, with every claim linked to the FDA record behind it. Built for the Open Agent Hackathon 2026, Track 02 "The Agent That Can Explain Why".

**Status: in development (Open Agent Hackathon 2026)**

## Build the sample hospital data

```bash
npm install
npm run build-sample
```

This queries the openFDA NDC directory for real marketed products from a fixed list of hospital staples, then writes `data/hospital/seed.sql` and `data/hospital/products.json`. Synthetic stock, usage and orders sit on top of those real FDA listings and are labelled as sample data.
