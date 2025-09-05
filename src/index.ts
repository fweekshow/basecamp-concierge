import { Client, type Signer, type DecodedMessage, Group } from "@xmtp/node-sdk";
import { createReminderDispatcher } from "./dispatcher.js";
import { isMentioned, removeMention } from "./mentions.js";
import { AIAgent } from "./services/agent/index.js";
import {
  createSigner,
  getDbPath,
  getEncryptionKeyFromHex,
  logAgentDetails,
} from "./services/helpers/client.js";
import { initDb } from "./store.js";
import {
  DEBUG_LOGS,
  DB_ENCRYPTION_KEY,
  MENTION_HANDLES,
  SHOW_SENDER_ADDRESS,
  WALLET_KEY,
  XMTP_ENV,
} from "./config.js";

if (!WALLET_KEY) {
  throw new Error("WALLET_KEY is required");
}

if (!DB_ENCRYPTION_KEY) {
  throw new Error("DB_ENCRYPTION_KEY is required");
}

if (!XMTP_ENV) {
  throw new Error("XMTP_ENV is required");
}

const signer = createSigner(WALLET_KEY);
const encryptionKey = getEncryptionKeyFromHex(DB_ENCRYPTION_KEY);

console.log(`🚀 Starting Basecamp 2025 Concierge Agent`);

// Initialize database for reminders
initDb();

// Initialize AI agent
const agent = new AIAgent();

async function handleMessage(message: DecodedMessage, client: Client) {
  try {
    const messageContent = message.content as string;
    const senderInboxId = message.senderInboxId;
    const conversationId = message.conversationId;

    if (DEBUG_LOGS) {
      console.log(`📥 Received message:`, {
        id: message.id,
        senderInboxId,
        conversationId,
        content: messageContent,
      });
    }

    // Skip messages from ourselves
    if (senderInboxId === client.inboxId) {
      if (DEBUG_LOGS) {
        console.log("⏭️ Skipping own message");
      }
      return;
    }

    // Get conversation to check if it's a group
    const conversation = await client.conversations.getConversationById(conversationId);
    if (!conversation) {
      console.error("❌ Could not find conversation");
      return;
    }

    const isGroup = conversation instanceof Group;
    let cleanContent = messageContent;

    // Always respond to all messages, but clean mentions from groups
    if (isGroup && isMentioned(messageContent)) {
      cleanContent = removeMention(messageContent);
      if (DEBUG_LOGS) {
        console.log("👋 Mentioned in group, will respond");
      }
    } else if (!isGroup) {
      if (DEBUG_LOGS) {
        console.log("💬 DM received, will respond");
      }
    } else if (isGroup && !isMentioned(messageContent)) {
      if (DEBUG_LOGS) {
        console.log("⏭️ Not mentioned in group, skipping");
      }
      return;
    }

    // Get sender address for context
    let senderAddress = "";
    if (SHOW_SENDER_ADDRESS) {
      try {
        // Use the sender's inbox ID to get their address
        senderAddress = senderInboxId;
      } catch (error) {
        console.warn("⚠️ Could not get sender address:", error);
      }
    }

    try {
      console.log(`🤖 Processing message: "${cleanContent}"`);
      
      // Check for broadcast command (only in DMs, only for authorized user)
      if (!isGroup && cleanContent.toLowerCase().startsWith("broadcast ") && 
          (senderAddress === "0x22209cfc1397832f32160239c902b10a624cab1a" || 
           senderAddress.toLowerCase() === "0x22209cfc1397832f32160239c902b10a624cab1a")) {
        
        const broadcastMessage = cleanContent.substring(10).trim(); // Remove "broadcast " prefix
        
        if (!broadcastMessage) {
          await conversation.send("❌ Broadcast message cannot be empty. Use: broadcast [your message]");
          return;
        }
        
        try {
          console.log(`📢 Broadcast command from ${senderAddress}: "${broadcastMessage}"`);
          
          // Get all conversations
          await client.conversations.sync();
          const allConversations = await client.conversations.list();
          
          if (allConversations.length === 0) {
            await conversation.send("⚠️ No conversations found to broadcast to.");
            return;
          }
          
          // Prepare broadcast message
          const broadcastContent = `📢 BASECAMP 2025 BROADCAST\n\n${broadcastMessage}\n\n---\nSent by: 0x222...`;
          
          let successCount = 0;
          let errorCount = 0;
          
          // Send to all conversations except the current one
          for (const conv of allConversations) {
            try {
              if (conv.id !== conversationId) {
                await conv.send(broadcastContent);
                successCount++;
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            } catch (error: any) {
              console.error(`❌ Failed to send broadcast to conversation ${conv.id}:`, error);
              errorCount++;
            }
          }
          
          const resultMessage = `✅ Broadcast sent!\n\n📊 Results:\n• Delivered to: ${successCount} conversations\n• Failed: ${errorCount}\n• Total: ${allConversations.length}`;
          await conversation.send(resultMessage);
          console.log(`📢 Broadcast completed: ${successCount} success, ${errorCount} errors`);
          return;
          
        } catch (error: any) {
          await conversation.send(`❌ Failed to send broadcast: ${error.message}`);
          console.error("❌ Broadcast failed:", error);
          return;
        }
      }
      
      // Check for DM me command to establish DM connection
      if (cleanContent.toLowerCase().includes("dm me") || cleanContent.toLowerCase().includes("start dm")) {
        try {
          console.log(`📱 DM request from ${senderAddress}, attempting to establish DM connection...`);
          
          // Try to create DM with the sender
          const dmConversation = await client.conversations.newDm(senderAddress);
          const dmMessage = `Hi! I'm starting this DM as requested. You can now message me directly here for private conversations about Basecamp 2025!`;
          
          await dmConversation.send(dmMessage);
          await conversation.send(`✅ DM started! Check your direct messages.`);
          console.log(`✅ Established DM with ${senderAddress}`);
          return;
          
        } catch (dmError: any) {
          await conversation.send(`❌ Failed to start DM: ${dmError.message}`);
          console.error(`❌ DM establishment failed:`, dmError);
          return;
        }
      }
      
      // Check for manual message command (admin only - using inbox ID or wallet address)
      const isAdmin = senderInboxId === "eb180ab2a24df3e54a78b065c89be3cbd0bd22ef5e34654c481f0cef7eab4b47" || 
                     senderAddress === "0x327bf6a70433f2893eacde947ffec2ef9b918f5a" ||
                     senderAddress.includes("eb180ab2a24df3e54a78b065c89be3cbd0bd22ef5e34654c481f0cef7eab4b47");
      
      if (cleanContent.startsWith("SEND_TO:") && isAdmin) {
        const parts = cleanContent.split(":");
        if (parts.length >= 3) {
          const rawTargetAddress = parts[1].trim();
          // Ensure 0x prefix is present for XMTP compatibility
          const targetAddress = rawTargetAddress.startsWith("0x") ? rawTargetAddress : `0x${rawTargetAddress}`;
          const messageToSend = parts.slice(2).join(":").trim();
          
          try {
            console.log(`📤 Admin command: Sending manual message to ${rawTargetAddress} (formatted: ${targetAddress})`);
            const targetConversation = await client.conversations.newDm(targetAddress);
            await targetConversation.send(messageToSend);
            await conversation.send(`✅ Message sent to ${targetAddress}: "${messageToSend}"`);
            console.log(`✅ Manual message sent to ${targetAddress}`);
            return;
          } catch (sendError: any) {
            await conversation.send(`❌ Failed to send message to ${targetAddress}: ${sendError.message}`);
            console.error(`❌ Manual send failed:`, sendError);
            return;
          }
        }
      }
      
      // Generate AI response
      const response = await agent.run(
        cleanContent,
        senderInboxId,
        conversationId,
        isGroup,
        senderAddress,
      );

      if (response) {
        await conversation.send(response);
        console.log(`✅ Sent response: "${response}"`);
      }
    } catch (error) {
      console.error("❌ Error generating or sending response:", error);
      
      // Send fallback message
      try {
        await conversation.send(
          "Sorry, I encountered an error while processing your request. Please try again later."
        );
      } catch (fallbackError) {
        console.error("❌ Error sending fallback message:", fallbackError);
      }
    }
  } catch (error) {
    console.error("❌ Error processing message:", error);
  }
}

async function main() {
  try {
    const dbPath = getDbPath("basecamp-agent");
    const client = await Client.create(signer, {
      dbEncryptionKey: encryptionKey,
      env: XMTP_ENV as "local" | "dev" | "production",
      dbPath,
    });
    
    await logAgentDetails(client);

    // Initialize reminder dispatcher
    const reminderDispatcher = createReminderDispatcher();
    reminderDispatcher.start(client);

    // Handle process termination
    const cleanup = () => {
      console.log("🛑 Shutting down agent...");
      reminderDispatcher.stop();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    console.log("👂 Listening for messages...");
    console.log("💬 Agent will only respond to:");
    console.log("  - Direct messages (DMs)");
    console.log(`  - Group messages when mentioned with @${MENTION_HANDLES.split(',')[0]}`);
    
    // Sync conversations before streaming
    console.log("🔄 Syncing conversations...");
    await client.conversations.sync();
    
    // Listen for new conversations to send welcome messages
    console.log("📡 Starting conversation stream...");
    const conversationStream = await client.conversations.stream();
    
    // Handle new conversations in background (disabled to prevent double messages)
    // (async () => {
    //   for await (const conversation of conversationStream) {
    //     try {
    //       const isGroup = conversation instanceof Group;
    //       
    //       if (!isGroup) {
    //         // Send welcome message to new DMs
    //         const welcomeMessage = `Hi! I'm the Basecamp 2025 Concierge - your helpful assistant for Basecamp. I can help you with:

    // • Schedule: Get event times, daily agendas for Sept 14-16, 2025
    // • General Info: Event details, logistics, and FAQ
    // • Reminders: Set personal reminders for sessions and activities

    // What would you like to know about Basecamp 2025?

    // Official site: https://www.basecamp2025.xyz 
    // Updates: @base`;

    //         if (conversation) {
    //           await conversation.send(welcomeMessage);
    //           console.log(`✅ Sent welcome message to new DM conversation`);
    //         }
    //       }
    //     } catch (error) {
    //       console.error("❌ Error sending welcome message:", error);
    //     }
    //   }
    // })();

    // Start streaming messages
    console.log("📡 Starting message stream...");
    const stream = await client.conversations.streamAllMessages();
    
    for await (const message of stream) {
      // Skip messages from ourselves or non-text messages
      if (
        message?.senderInboxId.toLowerCase() === client.inboxId.toLowerCase() ||
        message?.contentType?.typeId !== "text"
      ) {
        continue;
      }
      
      await handleMessage(message, client);
    }

  } catch (error) {
    console.error("❌ Error starting agent:", error);
    process.exit(1);
  }
}

main().catch(console.error);