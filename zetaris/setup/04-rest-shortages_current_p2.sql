CREATE LIGHTNING REST TABLE shortages_current_p2 FROM OPENFDA_REST REQUEST(
    endpoint "https://api.fda.gov/drug/shortages.json?search=status:%22Current%22&limit=1000&skip=1000",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()
