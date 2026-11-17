# Will Robinson portfolio

The live site files are in `site/`. From the repository root, start a local server with:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory site
```

The portfolio uses Bootswatch Flatly 5.3.8, a Bootstrap 5 theme, with local overrides in `site/assets/portfolio.css`. The vendored theme omits the Google Fonts import and uses system fonts. No build or package installation is required.

## GitHub Pages

In the repository's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**. The deployment workflow runs on pushes to `main` and can also be triggered manually from the Actions tab. It uploads only `site/`.

The original site and its assets are preserved in `retired_pages/`, outside the deployment artifact. That directory remains browsable in the repository if the repository is public.
