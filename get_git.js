const { Octokit } = require("@octokit/core");
const { ChatOpenAI } = require("langchain/chat_models/openai");
const { HumanChatMessage, AIChatMessage } = require("langchain/schema");
// Import recursive-text-splitter from langchain
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

require('dotenv').config();

let listOfContents = [];

// Get contents of a GitHub repo recursively
async function getGitHub(owner, repo, path = '') {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  // Create a content splitter
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 100, separators: ['\n\n','\n', '.', '?', '!']});

  const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    // Only add path if it's not empty
    ...(path && { path })
  });
  // Loop through each item in the directory
  for (const item of data) {
    // If the item is a directory, recursively call getGitHub again
    if (item.type === 'dir') {
      await getGitHub(owner, repo, item.path);
    } else if (item.type === 'file') {
      // If item.name is one of these, ignore it: .gitignore, listofdocs.json, package.json, , package-lock.json
      if (item.name === '.gitignore' || item.name === 'listofdocs.json' || item.name === 'package.json' || item.name === 'package-lock.json') {
        continue;
      }
      // If it's not a directory, grab the file using octokit
      const file = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: item.path
      });
      // If the item is a file, decode the content and log it
      const buff = Buffer.from(file.data.content, 'base64');
      const text = buff.toString('utf-8');

      // Split the text into chunks
      const chunks = splitter.split(text);
      // Loop through each chunk
      for (const chunk of chunks) {
        // Use the OpenAI model to analyze the code
        const response = await getOpenAIResponse(item.name, text);
        listOfContents.push(response);
      }
    }
  }
  await summariseList();
}

async function getOpenAIResponse(name, content) {
  const model = new ChatOpenAI({openAIApiKey: process.env.OPENAI_API_KEY, temperature: 1.1});
  // Convert the content to a string
  const response = await model.call(
    [
      new AIChatMessage("Analyse the following text and explain in 2 sentences what it does:\n\n"),
      new HumanChatMessage(content),
    ],
  );
  // Create json for the response and name
  const json = {
    name: name,
    response: response.text
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
      new AIChatMessage("Summarise the following list of files for a general information paragraph:\n\n"),
      new HumanChatMessage(responseString),
    ],
  );
  console.log(response.text);
}

getGitHub('Aw3ra', 'repo-describer');
