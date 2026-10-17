export const config = {
  port: Number(process.env.PORT ?? 3000),
  db: {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? "ops",
    password: process.env.POSTGRES_PASSWORD ?? "ops",
    database: process.env.POSTGRES_DB ?? "ops",
  },
  maxPageSize: 100,
  defaultPageSize: 25,
};
