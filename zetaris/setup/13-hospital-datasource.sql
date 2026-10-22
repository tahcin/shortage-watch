CREATE DATASOURCE hospital_pg DESCRIBE BY "Sample hospital pharmacy database" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://hospital-db:5432/hospital",
  username "buyer",
  password "${HOSPITAL_DB_PASSWORD}",
  fetchsize "1000"
)
