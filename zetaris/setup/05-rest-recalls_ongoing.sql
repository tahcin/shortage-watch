CREATE LIGHTNING REST TABLE recalls_ongoing FROM OPENFDA_REST REQUEST(
    endpoint "https://api.fda.gov/drug/enforcement.json?search=status:%22Ongoing%22&limit=1000",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()
