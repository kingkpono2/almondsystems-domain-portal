# Almond Systems Domain Portal

React and Node.js domain registration portal for Almond Systems, with Paystack checkout, Name.com domain search/registration workflow, account/cart management, email notifications, admin approval, and the AlmondShipping WordPress plugin release.

## Included
- `frontend/` React domain portal.
- `server/` Node/Express API.
- `wordpress-plugins/almondshipping/` Nigerian Shipping Rates for WooCommerce plugin source.
- `releases/` packaged AlmondShipping ZIP and download helper.

## Deployment Notes
- Secrets are not committed. Configure Name.com, Paystack, SMTP, and admin keys via environment variables.
- The production server currently runs this app through Docker Compose under `/srv/.xter/apps/almondsystems`.
