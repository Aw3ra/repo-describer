const { Octokit } = require("@octokit/core");
const { ChatOpenAI } = require("langchain/chat_models/openai");
const { HumanChatMessage, AIChatMessage } = require("langchain/schema");
require('dotenv').config();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Get contents of a GitHub repo recursively
async function getGitHub(owner, repo, path = '') {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    path
  });
  // Loop through each item in the directory
  for (const item of data) {
    // If the item is a directory, recursively call getGitHub again
    if (item.type === 'dir') {
      await getGitHub(owner, repo, item.path);
    } else if (item.type === 'file') {
      // If it's not a directory, grab the file using octokit
      const file = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: item.path
      });
      // If the item is a file, decode the content and log it
      const buff = Buffer.from(file.data.content, 'base64');
      const text = buff.toString('utf-8');

      // Use the OpenAI model to analyze the code
      await getOpenAIResponse(item.name,text);
    }
  }
}

async function getOpenAIResponse(name, content) {
  const model = new ChatOpenAI({openAIApiKey: process.env.OPENAI_API_KEY, temperature: 1.1});
  
  const response = await model.call(
    [
      new AIChatMessage("Analyse the following code and explain in 2 sentences what it does:\n\n"),
      new HumanChatMessage(content),
    ],
  );
  console.log("\nName: "+name+'\nDescription: '+response.text);
}

getGitHub('Aw3ra', 'dougbert');
