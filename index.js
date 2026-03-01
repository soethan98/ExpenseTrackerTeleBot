import 'dotenv/config';
import express, { json } from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { Client } from '@notionhq/client';
import { Groq } from 'groq-sdk';

const app = express();
app.use(json());

// Initialize clients
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });


// Available categories in your Notion database
const AVAILABLE_CATEGORIES = [
  'Transportation', 'Phone Bills', 'Present', 'Electric Bill', 'Gas',
  'Medical', 'Utilities', 'Kitchen ware', 'Electronic', 'Trip',
  'Entertainment', 'House Rent', 'Tax', 'Home', 'Clothing',
  'Beauty', 'Foods', 'Groceries', 'Education', 'Book',
  'Laundry', 'Internet', 'Investment', 'Subscriptions', 'Clothe', 'Badminton'
];

async function categorizeExpense(description) {
  try {
    const prompt = `You are an expense categorizer. Given a description, choose the most appropriate category from this list:
${AVAILABLE_CATEGORIES.join(', ')}

Description: "${description}"

Respond with ONLY the category name, nothing else. Choose the single most appropriate category.`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 50
    });

    const category = completion.choices[0]?.message?.content?.trim();
    
    // Verify the category is valid
    if (AVAILABLE_CATEGORIES.includes(category)) {
      return category;
    }
    
    // Default fallback
    return 'Foods';
  } catch (error) {
    console.error('Error with Groq AI:', error);
    return 'Foods'; // Default fallback
  }
}


// Parse expense message
function parseExpense(text) {
  // Match patterns like "Meal 3.5" or "Meal $3.5" or "Meal: $3.5"
  const match = text.match(/^(.+?)[\s:]*\$?(\d+\.?\d*)\s*$/i);
  
  if (!match) return null;
  
  return {
    description: match[1].trim(),
    amount: parseFloat(match[2])
  };
}

// Query Notion for existing entry
async function findExistingEntry(description, date) {
  try {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
        and: [
          {
            property: 'Description',
            title: {
              equals: description
            }
          },
          {
            property: 'Date',
            date: {
              equals: date
            }
          }
        ]
      }
    });
    
    return response.results.length > 0 ? response.results[0] : null;
  } catch (error) {
    console.error('Error querying Notion:', error);
    return null;
  }
}

// Create new Notion entry
async function createNotionEntry(description, category, amount, date) {
  try {
    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        'Description': {
          title: [{ text: { content: description } }]
        },
        'Category': {
          select: { name: category }
        },
        'Total': {
          number: amount
        },
        'Date': {
          date: { start: date }
        }
      }
    });
    return true;
  } catch (error) {
    console.error('Error creating Notion entry:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    return false;
  }
}

// Update existing Notion entry
async function updateNotionEntry(pageId, newTotal) {
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        'Total': {
          number: newTotal
        }
      }
    });
    return true;
  } catch (error) {
    console.error('Error updating Notion entry:', error);
    return false;
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Parse the expense
  const expense = parseExpense(text);
  
  if (!expense) {
    bot.sendMessage(chatId, '❌ Invalid format. Use: Description $Amount\nExample: Meal $3.5 or Coffee 5');
    return;
  }
  
  // Send "processing" message
  bot.sendMessage(chatId, '🤖 Processing...');
  
  // Use AI to determine category
  const category = await categorizeExpense(expense.description);
  
  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split('T')[0];
  
  // Check if entry exists for this description today
  const existing = await findExistingEntry(expense.description, today);
  
  if (existing) {
    // Update existing entry
    const currentAmount = existing.properties.Total.number;
    const newTotal = currentAmount + expense.amount;
    
    const success = await updateNotionEntry(existing.id, newTotal);
    
    if (success) {
      bot.sendMessage(chatId, 
        `✅ Updated!\n` +
        `📝 ${expense.description}\n` +
        `🏷️ ${category}\n` +
        `💰 $${newTotal.toFixed(2)} total today`
      );
    } else {
      bot.sendMessage(chatId, '❌ Failed to update Notion. Please try again.');
    }
  } else {
    // Create new entry
    const success = await createNotionEntry(expense.description, category, expense.amount, today);
    
    if (success) {
      bot.sendMessage(chatId, 
        `✅ Logged!\n` +
        `📝 ${expense.description}\n` +
        `🏷️ ${category}\n` +
        `💰 $${expense.amount.toFixed(2)}`
      );
    } else {
      bot.sendMessage(chatId, '❌ Failed to save to Notion. Please check your database properties match the code.');
    }
  }
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  const msg = req.body.message;
  
  if (msg && msg.text) {
    handleMessage(msg);
  }
  
  res.sendStatus(200);
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Expense Tracker Bot is running! 🚀');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
