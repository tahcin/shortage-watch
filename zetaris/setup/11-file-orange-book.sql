CREATE LIGHTNING FILESTORE TABLE orange_book_products FROM FDA_FILES FORMAT CSV OPTIONS (
  path "file:///home/zetaris/customer-data/shared/orangebook/products.txt",
  header "true",
  delimiter "~"
)
