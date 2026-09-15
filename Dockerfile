# Exists so Glama's listing check can start the server and introspect it. That
# check needs no credentials: the server boots with none, advertises its three
# tools, and only asks for a key or wallet when a paid tool is actually called.
#
# This image is NOT an invitation to host the server. store_secret encrypts in
# this process, so whoever runs the container holds the plaintext, and
# retrieve_secret takes a token carrying the decryption key. Run it on the
# machine that owns the secret. See README, "Why there is no hosted version".
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs lib.mjs ./
CMD ["node", "server.mjs"]
