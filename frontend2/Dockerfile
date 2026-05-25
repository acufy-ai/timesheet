# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=http://localhost:8000
ARG VITE_BASE_PATH=/
ARG VITE_AUTH0_DOMAIN=
ARG VITE_AUTH0_CLIENT_ID=
ARG VITE_AUTH0_AUDIENCE=
ARG VITE_AUTH0_CONNECTION=Username-Password-Authentication
# FrontendSwitcher: target URL/path for the sibling UI. Empty
# VITE_FRONTEND_OTHER_URL means "same origin, just navigate to the
# path" (production). Set a full URL for cross-origin dev mode.
ARG VITE_FRONTEND_OTHER_URL=
ARG VITE_FRONTEND_OTHER_PATH=/legacy/
ARG VITE_FRONTEND_OTHER_LABEL=Classic UI
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_AUTH0_DOMAIN=$VITE_AUTH0_DOMAIN
ENV VITE_AUTH0_CLIENT_ID=$VITE_AUTH0_CLIENT_ID
ENV VITE_AUTH0_AUDIENCE=$VITE_AUTH0_AUDIENCE
ENV VITE_AUTH0_CONNECTION=$VITE_AUTH0_CONNECTION
ENV VITE_FRONTEND_OTHER_URL=$VITE_FRONTEND_OTHER_URL
ENV VITE_FRONTEND_OTHER_PATH=$VITE_FRONTEND_OTHER_PATH
ENV VITE_FRONTEND_OTHER_LABEL=$VITE_FRONTEND_OTHER_LABEL
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf.template
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
EXPOSE 80
CMD ["/bin/sh", "-c", "BASE=$(echo ${VITE_BASE_PATH} | sed -e 's|^/$||' -e 's|/$||'); BASE_ROOT=${BASE:-/}; sed -e \"s|__BASE_PATH_ROOT__|${BASE_ROOT}|g\" -e \"s|__BASE_PATH__|${BASE}|g\" /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
