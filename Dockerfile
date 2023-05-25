FROM node:17 as builder

# Install DEB dependencies and others.
RUN \
	set -x \
	&& apt-get update \
	&& apt-get install -y net-tools build-essential python3 python3-pip valgrind

# Create app directory
WORKDIR /usr/src/app

# Typescript deps
COPY tsconfig.json ./

# Install app dependencies
COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM node:17-slim

# Install DEB dependencies and others.
RUN \
	set -x \
	&& apt-get update \
	&& apt-get install -y net-tools build-essential python3 python3-pip valgrind

ENV NODE_ENV production
ENV PORT 6000
USER node

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

RUN npm ci --production

COPY --from=builder /usr/src/app/credentials ./credentials
COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 6000
CMD [ "node", "dist/src/server.js" ]