# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# Sub-path + API origin are baked at build time so the SPA's asset URLs and
# API calls resolve correctly behind the host reverse-proxy.
#   VITE_BASE_PATH    e.g. /apps/timesheet/  (default / for root deploys)
#   VITE_API_BASE_URL e.g. https://acufy.ai/api  (default /api = same-origin proxy)
ARG VITE_BASE_PATH=/
ARG VITE_API_BASE_URL=/api
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
# `npm run build` runs `tsc -b && vite build`, so a TS error fails the build.
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf.template
# The SPA is served under VITE_BASE_PATH; templating the nginx config at
# container start keeps one image working for both root and sub-path deploys.
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
EXPOSE 80
# Normalize the base path to a no-trailing-slash form for location prefixes,
# render the template, then start nginx.
CMD ["/bin/sh", "-c", "BASE=$(echo ${VITE_BASE_PATH} | sed -e 's|/$||'); BASE_ROOT=${BASE:-/}; sed -e \"s|__BASE_PATH__|${BASE}|g\" -e \"s|__BASE_PATH_ROOT__|${BASE_ROOT}|g\" /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
