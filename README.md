# VectorRAGNuxt

Playing with Vector DBs / RAG / NUXT for a work skill pivot. Might throw this away and never touch again

## How to Run
Assuming you have pnpm

1. Install the necessary packages `$ pnpm install`
2. Scrape the cars manually `$ pnpm scrape [--from 2016] [--to 2026] [--makes honda,toyota] [--fresh]`
3. Run the webapp `$ pnpm dev` (it does nothing)

## Why?

"Don't worry about it, bro."

## What?

### Happy Path
As a User
When I submit a prompt
I want to see the closest car related to what was prompted

### Sad Path
As a User
When I submit a prompt for a van
I only see cars, vans and SUVs are not scraped

## TODO

- Seed scraped car data into local mongoDB
- Create NUXT RAG layer
- ???
- Chat Gippity
- Profit

## Tech Stack

- Nuxt.js
- Node 26
- MongoDB for a vectorDB
- ChatGPT's API (env key not included)

## Cool Credits

- Car data scraped from the [NHTSA vPIC API](https://vpic.nhtsa.dot.gov/api/)
