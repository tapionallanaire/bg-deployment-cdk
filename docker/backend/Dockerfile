ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG DEPLOYMENT_COLOR

RUN if [ "${DEPLOYMENT_COLOR}" = "green" ]; then \
    printf '%s\n' \
      '<!doctype html>' \
      '<html lang="en">' \
      '<head><meta charset="utf-8"><title>Green Deployment</title></head>' \
      '<body style="font-family: sans-serif; padding: 2rem; background: #edf7ed; color: #14532d;">' \
      '<h1>Green deployment candidate</h1>' \
      '<p>This is the green environment.</p>' \
      '<p>Served by nginx.</p>' \
      '</body>' \
      '</html>' \
      > /usr/share/nginx/html/index.html; \
  else \
    printf '%s\n' \
      '<!doctype html>' \
      '<html lang="en">' \
      '<head><meta charset="utf-8"><title>Blue Deployment</title></head>' \
      '<body style="font-family: sans-serif; padding: 2rem; background: #eff6ff; color: #1d4ed8;">' \
      '<h1>Blue deployment</h1>' \
      '<p>This is the current stable environment.</p>' \
      '<p>Served by nginx.</p>' \
      '</body>' \
      '</html>' \
      > /usr/share/nginx/html/index.html; \
  fi
