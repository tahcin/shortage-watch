CREATE SCHEMASTORE VIEW shortages_current_v WITH CONTAINER fda AS
SELECT r.generic_name, r.package_ndc, r.presentation, r.company_name, r.availability, r.shortage_reason, r.status, r.update_date, r.initial_posting_date, r.dosage_form, r.related_info, r.related_info_link, r.openfda.product_ndc AS product_ndcs, r.openfda.application_number AS application_numbers, r.openfda.substance_name AS substances, r.therapeutic_category
FROM openfda_rest.shortages_current LATERAL VIEW explode(results) AS r
UNION ALL
SELECT r.generic_name, r.package_ndc, r.presentation, r.company_name, r.availability, r.shortage_reason, r.status, r.update_date, r.initial_posting_date, r.dosage_form, r.related_info, r.related_info_link, r.openfda.product_ndc AS product_ndcs, r.openfda.application_number AS application_numbers, r.openfda.substance_name AS substances, r.therapeutic_category
FROM openfda_rest.shortages_current_p2 LATERAL VIEW explode(results) AS r
