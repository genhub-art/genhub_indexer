FROM node:alpine
WORKDIR /usr/nftm_indexer
COPY package.json .
RUN npm install\
        && npm install typescript -g
COPY . .
RUN tsc
EXPOSE 8080

CMD ["node", "dist/app.js"]