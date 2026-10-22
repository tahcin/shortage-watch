CREATE SCHEMASTORE VIEW orange_book_v WITH CONTAINER fda AS
SELECT Ingredient AS ingredient, `DF;Route` AS df_route, Trade_Name AS trade_name, Applicant AS applicant, Strength AS strength, Appl_Type AS appl_type, Appl_No AS appl_no, Product_No AS product_no, TE_Code AS te_code, Approval_Date AS approval_date, RLD AS rld, RS AS rs, Type AS type, Applicant_Full_Name AS applicant_full_name
FROM fda_files.orange_book_products
