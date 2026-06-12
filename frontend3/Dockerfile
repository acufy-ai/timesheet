# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# frontend3 talks to the API via a RELATIVE '/api' baseURL (reverse-proxied by
# nginx in the production stage), so no VITE_API_BASE_URL is baked in.
# `npm run build` runs `tsc -b && vite build`, so a TS error fails the build.
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
