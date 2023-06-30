const { Octokit } = require("@octokit/core");
const { ChatOpenAI } = require("langchain/chat_models/openai");
const {OpenAIEmbeddings} = require("langchain/embeddings/openai");
const { HumanChatMessage, AIChatMessage, SystemChatMessage } = require("langchain/schema");
// Import recursive-text-splitter from langchain
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { PineconeClient } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("langchain/vectorstores");
const {Document} = require("langchain/document");
const {fs} = require('fs');
const retry = require('async-retry');

require('dotenv').config();

const model = new ChatOpenAI({openAIApiKey: process.env.OPENAI_API_KEY, temperature: 1.1});
let listOfContents = [];

async function getGitHub(owner, repo, path = '') {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 4000, chunkOverlap: 100, separators: ['\n\n','\n', '.', '?', '!']});
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    ...(path && { path })
  });

  if (data.status === 404) {
    console.log('404');
    return;
  }

  const promises = [];

  for (const item of data) {
    if (item.type === 'dir') {
      // If the directory is node_moduels, ignore it
      if (item.name === 'node_modules') {
        continue;
      }
      promises.push(getGitHub(owner, repo, item.path));
    } else if (item.type === 'file') {
      if (item.name === '.gitignore' || item.name === 'listofdocs.json' || item.name === 'package.json' || item.name === 'package-lock.json' || item.name[0] === '.' || item.name.includes('.png') || item.name.includes('.jpg') || item.name.includes('.jpeg') || item.name.includes('.gif') || item.name.includes('.mp4') || item.name.includes('.mov') || item.name.includes('.avi') || item.name.includes('.webm')) {
        continue;
      }

      const promise = octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: item.path
      }).then(async (file) => {
        const buff = Buffer.from(file.data.content, 'base64');
        const text = buff.toString('utf-8');
        console.log("Looking at file: " + item.name +"\n\n")
        const metadata = {
          name: item.name,
          path: item.path,
          url: item.html_url
        }
        const chunks = await splitter.createDocuments([text], [metadata]);
        return Promise.allSettled(chunks.map(chunk => getOpenAIResponse(metadata.name, metadata.path, chunk.pageContent)));
      });

      promises.push(promise);
    }
  }

  const results = await Promise.allSettled(promises);

  // Here you can handle the results of your promises
  for (const result of results) {
    if (result.status === 'fulfilled') {
      // If the result of the promise is an array (from the file promises), iterate over it
      if (Array.isArray(result.value)) {
        for (const subresult of result.value) {
          if (subresult.status === 'fulfilled') {
            listOfContents.push(subresult.value);
          } else {
            console.error(`Rejected promise for chunk analysis: ${subresult.reason}`);
          }
        }
      }
      // Else if the result of the promise is not an array (from the directory promises), you can handle it directly
      else {
        // handle directory promise result
      }
    } else {
      console.error(`Rejected promise for file or directory: ${result.reason}`);
    }
  }
}

async function getOpenAIResponse(name, path, content) {
  console.log("Writing file: " + name +"\n\n")
  const response = await retry(async bail => {
    // If anything throws, we retry
    const result = await model.call(
      [
        new SystemChatMessage("Analyse the following text and explain in 2 sentences what it does, if it does nothing then say 'nothing':\n\n"),
        new HumanChatMessage(content),
      ],
    );
    // If result is not an AICHatMessage, check the status code
    if (!(result instanceof AIChatMessage)) {
      // If the status is 429 (Rate Limit Exceeded), we retry
      if (result.status === 429) throw new Error('Rate limit exceeded');
      
      // If the status is not 200, don't retry, just fail
      if (result.status !== 200) bail(new Error('Request failed'));
      
      return result;
    }
   
    return result;
  }, {
    retries: 5,  // Maximum amount of retries
    minTimeout: 10 * 60,  // Initial timeout in ms, here set to 1 minute
    factor: 2,  // Exponential factor
  });

  // Create json for the response and name
  const json = {
    name: name,
    path: path,
    description: response.text
  }
  return json;
}

// Function to summarise the list of content using OpenAI
async function summariseList() {
  const model = new ChatOpenAI({openAIApiKey: process.env.OPENAI_API_KEY, temperature: 1.1});
  // Convert the array of json objects that is listOfContents to a string
  const responseString = JSON.stringify(listOfContents);
  const response = await model.call(
    [
      new SystemChatMessage(
        `You are an AI tasked with describing a github repo, here are all the files within the repo and a breif description of each.`),
      new HumanChatMessage(responseString),  
      new AIChatMessage(`I will now describe the whole repository in 5-6 sentences, I will ignore any context related to config and setup and I will focus on explaining the overal purpose of the repository. I will ensure that my response is a paragraph that very accurately describes the repo and it's purpose, using general detail and very little specifics. If the README.md is comprehensive, focus on ascertaining the purpose of the repo centred around the README.md. If the README.md is not comprehensive, focus on ascertaining the purpose of the repo centred around the code. `),
        // Ignoring setup files and config files, write a short paragraph describing the repo and it's purpose:\n\n`),
    ],
  );
  console.log(response.text);
  return response.text;
}

// Function to convert the summarised list into pinecone vector embeddings
async function convertToPinecone(docs) {
  const documents = docs;
  console.log(documents);
  const client = new PineconeClient();
  const embeddings = new OpenAIEmbeddings({openAIApiKey: process.env.OPENAI_API_KEY});
  await client.init({
    apiKey: process.env.PINECONE_API_KEY,
    environment: process.env.PINECONE_ENVIRONMENT,
  });
  
  const pineconeIndex = client.Index(process.env.PINECONE_INDEX);

  await PineconeStore.fromDocuments(
    [documents],
    embeddings,
    { pineconeIndex, namespace: 'solana' }, 
  );
}

  


async function main() {
  console.log('Starting');
  await getGitHub('solhosty', 'compression-nfts');
  console.log('Finished getting github');
  const description = await summariseList();
  console.log('Finished summarising list');
  const metadata = {"Projectname": 'compression-nfts', "url": 'https://github.com/solhosty/compression-nfts', "author": 'Solhosty'};
  console.log('Finished creating metadata');
  const fullDocument = new Document({pageContent: description, metadata: metadata});
  console.log(fullDocument);
  await convertToPinecone(fullDocument);
  console.log('Finished uploading to pinecone');
}

main();
