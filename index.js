import 'dotenv/config';
import express, { json } from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { Groq } from 'groq-sdk';
import { Client } from '@notionhq/client';

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

// Parse various date formats
function parseDate(dateStr) {
  try {
    // Format 1: DD/MM (e.g., "15/03")
    const ddmmMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (ddmmMatch) {
      const day = parseInt(ddmmMatch[1]);
      const month = parseInt(ddmmMatch[2]);
      const year = new Date().getFullYear();

      // Validate
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;

      // Format as YYYY-MM-DD
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // Format 2: DD/MM/YYYY (e.g., "15/03/2026")
    const ddmmyyyyMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ddmmyyyyMatch) {
      const day = parseInt(ddmmyyyyMatch[1]);
      const month = parseInt(ddmmyyyyMatch[2]);
      const year = parseInt(ddmmyyyyMatch[3]);

      // Validate
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;

      // Format as YYYY-MM-DD
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // Format 3: YYYY-MM-DD (e.g., "2026-03-15")
    const isoMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1]);
      const month = parseInt(isoMatch[2]);
      const day = parseInt(isoMatch[3]);

      // Validate
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;

      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    return null;
  } catch (error) {
    return null;
  }
}

// Format date for display (DD/MM/YYYY)
function formatDateDisplay(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}


// Parse expense message
function parseExpense(text) {
  // Match patterns like "Meal 3.5" or "Meal $3.5" or "Meal: $3.5"
  const match = text.match(/^(.+?)[\s:]*\$?(\d+\.?\d*)\s*$/i);

  if (!match) return null;

  const description = match[1].trim();
  const amount = parseFloat(match[2]);
  const dateStr = match[3].trim();

  let date = null;

  if (dateStr) {
    // Try to parse the date
    date = parseDate(dateStr);
    if (!date) {
      return { error: 'Invalid date format. Use: DD/MM or DD/MM/YYYY or YYYY-MM-DD' };
    }
  }


  return {
    description: description,
    amount: amount,
    customDate: date  // null means use today
  };
}

// Query Notion for existing entry
async function findExistingEntry(description, date) {
  try {
    const response = await notion.dataSources.query({
      data_source_id: process.env.DATASOURCE_ID,
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

    console.log(`Search results for "${description}" on ${date}:`, response.results.length);


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
    bot.sendMessage(chatId, '❌ Invalid format. Use: Description $Amount [Date]\nExample: Meal $3.5 or Meal $3.5 15/03');
    return;
  }

  // Check for date parsing error
  if (expense.error) {
    bot.sendMessage(chatId, `❌ ${expense.error}`);
    return;
  }

  // Send "processing" message
  bot.sendMessage(chatId, '🤖 Processing...');

  // Use AI to determine category
  const category = await categorizeExpense(expense.description);

  // Get date - use custom date if provided, otherwise today
  const date = expense.customDate || new Date().toISOString().split('T')[0];


  console.log('=== NEW MESSAGE ===');
  console.log('Description:', expense.description);
  console.log('Amount:', expense.amount);
  console.log('Date:', date);
  console.log('Category:', category);


  // Check if entry exists for this description today
  const existing = await findExistingEntry(expense.description, date);

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
        `💰 $${newTotal.toFixed(2)} total`
      );
    } else {
      bot.sendMessage(chatId, '❌ Failed to update Notion. Please try again.');
    }
  } else {
    // Create new entry
    const success = await createNotionEntry(expense.description, category, expense.amount, date);

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
