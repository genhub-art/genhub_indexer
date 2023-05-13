# Indexer for http://genhub.art/

Built with nodejs.

Hosted on a cloud VPS using Docker.

Requires .env

```
DATABASE_URL=...
SEED_SHA256_SECRET=...
```

DATABASE_URL is a connection string to a PostgreSQL database. Currently using Supabase.

SEED_SHA256_SECRET is the secret seed used to generate unique seeds for the NFT generators.
