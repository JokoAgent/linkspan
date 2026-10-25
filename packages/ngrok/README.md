# ngrok adapter

`start(config, options)` implements HTTP, TLS passthrough and TCP carrying the
host's TLS using the official fixed `@ngrok/ngrok` SDK 1.7.0. The central
connectors package imports this optional package only when selected. A private
SDK session owns this adapter's listener; cleanup does not use global kill APIs.

Supply an existing publisher account token and explicit session/traffic budget.
TLS requires consent to an existing paid plan. TCP may require account/card
verification or a reservation. TCP/TLS need the exact public HTTPS origin whose
certificate the host serves; the SDK-assigned endpoint must match. Custom/free
domain eligibility, quotas, warning pages and actual hosted streams require
account testing. No plan or reservation purchase is performed.
