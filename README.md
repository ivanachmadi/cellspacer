# Cell Spacer Production Board

Static front end for GitHub Pages. The board data remains in the existing Supabase project.

## Publish with GitHub Pages

1. Create a **public** GitHub repository for this site if you use GitHub Free. GitHub Pages publishes a public website, and a public repository makes these source files visible to anyone.
2. Upload `index.html`, `styles.css`, `app.js`, and `.nojekyll` to the repository root.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/(root)`, then save.
5. Wait for the Pages deployment to finish and open the generated site URL.
6. Open the board's **Connect** settings, enter the existing Supabase Project URL and public anon/publishable key, then create a new **Share** link from the GitHub Pages address.

The SQL schema is not part of this website package. It has already been run in Supabase and does not need to be rerun for a hosting change.

## Important

- Never put a Supabase `service_role` or secret key in this repository.
- This app is designed for public browser use. Its current Supabase access policies allow people with the board connection details to read and edit board data. Hosting it on GitHub Pages does not change those database permissions.
- Keep the Netlify site available until the GitHub Pages site has been opened and checked on both a phone and a laptop. The two site addresses are separate; existing Netlify links will continue to open Netlify.
