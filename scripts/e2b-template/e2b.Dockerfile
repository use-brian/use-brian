# Use Brian computer-use sandbox template.
# Build instructions: docs/plans/e2b-template-setup.md

FROM e2bdev/code-interpreter:latest

# Trusted browser input, sandbox network isolation, and complete page rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
      util-linux \
      ca-certificates \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      && rm -rf /var/lib/apt/lists/*

# The provider drives this deterministic CLI for flat tools and reviewed skills.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g agent-browser \
    && HOME=/home/user agent-browser install --with-deps \
    && chown -R user:user /home/user/.agent-browser

# runPython uses the isolated unshare lane. browserExplore attaches browser-use
# to the same Chromium instance over CDP; no second browser is installed.
RUN pip install --no-cache-dir \
      pandas \
      numpy \
      browser-use==0.13.4

RUN mkdir -p /home/user/scratch /home/user/downloads \
    && chmod -R 777 /home/user/scratch /home/user/downloads

RUN command -v unshare && command -v agent-browser \
    && ls /home/user/.agent-browser/browsers/chrome-*/chrome \
    && python3 -c "import pandas, numpy, browser_use"
