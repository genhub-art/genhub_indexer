FROM buildkite/puppeteer
WORKDIR /usr/nftm_indexer
COPY package.json .
RUN npm install\
        && npm install typescript -g && npm install puppeteer
COPY . .
RUN tsc
EXPOSE 8080

CMD ["node", "dist/app.js"]