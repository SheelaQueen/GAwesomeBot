/* eslint-disable max-len, no-useless-return, max-depth */
const BaseEvent = require("./BaseEvent.js");
const { MicrosoftTranslate: mstranslate, Utils } = require("../Modules");
const {
	Gist,
	FilterChecker: checkFiltered,
} = Utils;
const levenshtein = require("fast-levenshtein");

class MessageCreate extends BaseEvent {
	requirements ({ msg }) {
		if (msg.author.id === this.bot.user.id || msg.author.bot || this.configJSON.globalBlocklist.includes(msg.author.id)) {
			if (msg.author.id === this.bot.user.id) {
				return false;
			} else {
				winston.silly(`Ignored ${msg.author.tag}.`, { usrid: msg.author.id, global_blocked: this.configJSON.globalBlocklist.includes(msg.author.id) });
				return false;
			}
		}
		return true;
	}

	/**
	 * Handles a MESSAGE_CREATE event
	 * @param {Message} msg The received message from Discord 
	 */
	async handle ({ msg }) {
		// Reload commands, dumb idea but whatever
		// Can we remove this after we are sure everything works?
		// Put it in ready or something
		this.bot.reloadAllCommands();
		// Handle private messages
		if (!msg.guild) {
			// Forward PM to maintainer(s) if enabled
			if (!this.configJSON.maintainers.includes(msg.author.id) && this.configJSON.pmForward) {
				let url = "";
				if (msg.content.length >= 1950) {
					const GistUpload = new Gist(this.bot);
					const res = await GistUpload.upload({
						title: "Bot DM",
						text: msg.content,
					});
					if (res.url) {
						url = res.url;
					}
				}
				for (const maintainerID of this.configJSON.maintainers) {
					let user = this.bot.users.get(maintainerID);
					if (!user) {
						user = await this.bot.fetchUser(maintainerID, true);
					}
					user.send({
						embed: {
							color: 0x3669FA,
							author: {
								name: `${msg.author.tag} just sent me a PM!`,
								icon_url: msg.author.displayAvatarURL,
							},
							description: `${url !== "" ? `The message was too large! Please go [here](${url}) to read it. 📨` : `\`\`\`${msg.content}\`\`\``}`,
						},
					});
				}
			}
			let command = msg.content.toLowerCase().trim();
			let suffix = "";
			if (command.includes(" ")) {
				command = command.split(" ")[0].toLowerCase().trim();
				suffix = msg.content.split(" ")
					.splice(1)
					.join(" ")
					.trim();
			}
			const commandFunction = this.bot.getPMCommand(command);
			if (commandFunction) {
				winston.verbose(`Treating "${msg.cleanContent}" as a PM command`, { usrid: msg.author.id, cmd: command });
				const findDocument = await this.db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
					winston.warn("Failed to find or create user data for message", { usrid: msg.author.id }, err);
				});
				const userDocument = findDocument.doc;
				userDocument.username = msg.author.tag;
				await userDocument.save().catch(err => {
					winston.verbose(`Failed to save user document...`, err);
				});
				try {
					await commandFunction({
						bot: this.bot,
						db: this.db,
						configJS: this.configJS,
						configJSON: this.configJSON,
						utils: Utils,
						Utils,
					}, userDocument, msg, suffix, {
						name: command,
						usage: this.bot.getPMCommandMetadata(command).usage,
					});
				} catch (err) {
					winston.warn(`Failed to process PM command "${command}"`, { usrid: msg.author.id }, err);
					msg.author.send({
						embed: {
							color: 0xFF0000,
							title: `Something went wrong! 😱`,
							description: `**Error Message**: \`\`\`js\n${err.stack}\`\`\``,
							footer: {
								text: `You should report this on GitHub so we can fix it!`,
							},
						},
					});
				}
			} else {
				// Process chatterbot prompt
				winston.verbose(`Treating "${msg.cleanContent}" as a PM chatterbot prompt`, { usrid: msg.author.id });
				const m = await msg.channel.send({
					embed: {
						color: 0x3669FA,
						description: `The chatter bot is thinking...`,
					},
				});
				const response = await this.chatterPrompt(msg.author.id, msg.cleanContent).catch(err => {
					winston.verbose(`Failed to get chatter prompt.`, err);
					m.edit({
						embed: {
							color: 0xFF0000,
							description: `Failed to get an answer, ok?!`,
						},
					});
				});
				if (response) {
					await m.edit({
						embed: {
							title: `The Program-O Chatter Bot replied with:`,
							url: `https://program-o.com`,
							description: response,
							thumbnail: {
								url: `https://cdn.program-o.com/images/program-o-luv-bunny.png`,
							},
							color: 0x00FF00,
						},
					});
				}
			}
		} else {
			// Handle public messages
			const serverDocument = await this.db.servers.findOne({ _id: msg.guild.id }).exec().catch(err => {
				winston.verbose("Failed to find server data for message", { svrid: msg.channel.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
			});
			if (serverDocument) {
				// Get channel data
				let channelDocument = serverDocument.channels.id(msg.channel.id);
				// Create channel data if not found
				if (!channelDocument) {
					serverDocument.channels.push({ _id: msg.channel.id });
					channelDocument = serverDocument.channels.id(msg.channel.id);
				}
				// Get member data (for this server)
				let memberDocument = serverDocument.members.id(msg.author.id);
				// Create member data if not found
				if (!memberDocument) {
					serverDocument.members.push({ _id: msg.author.id });
					memberDocument = serverDocument.members.id(msg.author.id);
				}
				const memberBotAdminLevel = this.bot.getUserBotAdmin(msg.guild, serverDocument, msg.member);
				// Increment today's message count for server
				serverDocument.messages_today++;
				// Count server stats if enabled in this channel
				if (channelDocument.isStatsEnabled) {
					// Increment this week's message count for member
					memberDocument.messages++;
					// Set now as the last active time for member
					memberDocument.last_active = Date.now();
					// Check if the user has leveled up a rank
					await this.bot.checkRank(msg.guild, serverDocument, msg.member, memberDocument);
					// Save changes to serverDocument
					await serverDocument.save().catch(err => {
						winston.warn(`Failed to save server data for MESSAGE`, { svrid: msg.guild.id }, err);
					});
				}

				// Check for start command from server admin
				if (!channelDocument.bot_enabled && memberBotAdminLevel > 1) {
					const startCommand = await this.bot.checkCommandTag(msg.content, serverDocument);
					if (startCommand && startCommand.command === "start") {
						channelDocument.bot_enabled = true;
						let inAllChannels = false;
						if (startCommand.suffix.toLowerCase().trim() === "all") {
							inAllChannels = true;
							serverDocument.channels.forEach(targetChannelDocument => {
								targetChannelDocument.bot_enabled = true;
							});
						}
						await serverDocument.save().catch(err => {
							winston.warn(`Failed to save server data for bot enable..`, { svrid: msg.guild.id }, err);
						});
						msg.channel.send({
							embed: {
								color: 0x3669FA,
								description: `Hello! I'm back${inAllChannels ? " in all channels" : ""}! 🐬`,
							},
						});
						return;
					}
				}

				// Check if using a filtered word
				if (checkFiltered(serverDocument, msg.channel, msg.content, false, true)) {
					// Delete offending message if necessary
					if (serverDocument.config.moderation.filters.custom_filter.delete_message) {
						try {
							await msg.delete();
						} catch (err) {
							winston.verbose(`Failed to delete filtered mesage from member "${msg.author.tag}" in channel ${msg.channel.name} on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
						}
					}
					// Get user data
					const findDocument = await this.db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
						winston.verbose("Failed to find or create user data for message filter violation", { usrid: msg.author.id }, err);
					});
					const userDocument = findDocument.doc;
					userDocument.username = msg.author.tag;
					await userDocument.save().catch(err => {
						winston.verbose(`Failed to save user document...`, err);
					});
					if (userDocument) {
						// Handle this as a violation
						let violatorRoleID = null;
						if (!isNaN(serverDocument.config.moderation.filters.custom_filter.violator_role_id) && !msg.member.roles.has(serverDocument.config.moderation.filters.custom_filter.violator_role_id)) {
							violatorRoleID = serverDocument.config.moderation.filters.custom_filter.violator_role_id;
						}
						await this.bot.handleViolation(msg.guild, serverDocument, msg.channel, msg.member, userDocument, memberDocument, `You used a filtered word in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `**@${this.bot.getName(msg.guild, serverDocument, msg.member, true)}** used a filtered word (\`${msg.cleanContent}\`) in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `Word filter violation ("${msg.cleanContent}") in #${msg.channel.name} (${msg.channel})`, serverDocument.config.moderation.filters.custom_filter.action, violatorRoleID);
					}
				}
				// Spam filter
				if (serverDocument.config.moderation.isEnabled && serverDocument.config.moderation.filters.spam_filter.isEnabled && !serverDocument.config.moderation.filters.spam_filter.disabled_channel_ids.includes(msg.channel.id) && memberBotAdminLevel < 1) {
					// Tracks spam with each new message (auto-delete after 45 seconds)
					let spamDocument = channelDocument.spam_filter_data.id(msg.author.id);
					if (!spamDocument) {
						channelDocument.spam_filter_data.push({ _id: msg.author.id });
						spamDocument = channelDocument.spam_filter_data.id(msg.author.id);
						spamDocument.message_count++;
						spamDocument.last_message_content = msg.cleanContent;
						this.bot.setTimeout(async () => {
							const newServerDocument = await this.db.servers.findOne({ _id: msg.guild.id }).exec().catch(err => {
								winston.verbose(`Failed to get server document for spam filter..`, err);
							});
							if (newServerDocument) {
								channelDocument = newServerDocument.channels.id(msg.channel.id);
								spamDocument = channelDocument.spam_filter_data.id(msg.author.id);
								if (spamDocument) {
									spamDocument.remove();
									await newServerDocument.save().catch(err => {
										winston.verbose("Failed to save server data for spam filter", { svrid: msg.guild.id }, err);
									});
								}
							}
						}, 45000);
						// Add this message to spamDocument if similar to the last one
					} else if (levenshtein.get(spamDocument.last_message_content, msg.cleanContent) < 3) {
						spamDocument.message_count++;
						spamDocument.last_message_content = msg.cleanContent;

						// First-time spam filter violation
						if (spamDocument.message_count === serverDocument.config.moderation.filters.spam_filter.message_sensitivity) {
							winston.verbose(`Handling first-time spam from member "${msg.author.tag}" in channel "${msg.channel.name}" on server "${msg.guild}" `, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });

							// Message user and tell them to stop
							msg.author.send({
								embed: {
									color: 0xFF0000,
									description: `Stop spamming in #${msg.channel.name} (${msg.channel}) on ${msg.guild}.\nThe chat moderators have been notified about this.`,
								},
							});

							// Message bot admins about user spamming
							await this.bot.messageBotAdmins(msg.guild, serverDocument, {
								embed: {
									color: 0xFF0000,
									description: `**@${this.bot.getName(msg.channel.guild, serverDocument, msg.member, true)}** is spamming in #${msg.channel.name} (${msg.channel}) on ${msg.guild}.`,
								},
							});

							// Deduct 25 GAwesomePoints if necessary
							if (serverDocument.config.commands.points.isEnabled) {
								// Get user data
								const findDocument = await this.db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
									winston.verbose(`Failed to find user document for spam filter...`, err);
								});
								const userDocument = findDocument.doc;
								userDocument.username = msg.author.tag;
								await userDocument.save().catch(err => {
									winston.verbose(`Failed to save user document...`, err);
								});
								if (userDocument) {
									userDocument.points -= 25;
									await userDocument.save().catch(err => {
										winston.verbose(`Failed to save user document for points`, { usrid: msg.author.id }, err);
									});
								}
							}
							// Add strike for user
							memberDocument.strikes.push({
								_id: this.bot.user.id,
								reason: `First-time spam violation in #${msg.channel.name} (${msg.channel})`,
							});
							// TODO: ModLog.create()
						} else if (spamDocument.message_count === serverDocument.config.moderation.filters.spam_filter.message_sensitivity * 2) {
							// Second-time spam filter violation
							winston.verbose(`Handling second-time spam from member "${msg.author.tag}" in channel "${msg.channel.name}" on server "${msg.guild}" `, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });
							// Delete spam messages if necessary
							if (serverDocument.config.moderation.filters.spam_filter.delete_messages) {
								const filteredMessages = [];
								const foundMessages = await msg.channel.fetchMessages({ limit: 50 }).catch(err => {
									winston.verbose(`Failed to fetch messages for spam filter..`, err);
								});
								foundMessages.forEach(foundMessage => {
									if (foundMessage.author.id === msg.author.id && levenshtein.get(spamDocument.last_message_content, foundMessage.cleanContent) < 3) {
										filteredMessages.push(foundMessage);
									}
								});
								if (filteredMessages.length >= 1) {
									try {
										await msg.channel.bulkDelete(filteredMessages, true);
									} catch (err) {
										winston.verbose(`Failed to delete spam messages from member "${msg.author.tag}" in channel "${msg.channel.name}" on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
									}
								}
							}

							// Get user data
							const findDocument = await this.db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
								winston.verbose(`Failed to get user document for second time spam filter...`, err);
							});
							const userDocument = findDocument.doc;
							userDocument.username = msg.author.tag;
							await userDocument.save().catch(err => {
								winston.verbose(`Failed to save user document...`, err);
							});
							if (userDocument) {
								// Handle this as a violation
								let violatorRoleID = null;
								if (!isNaN(serverDocument.config.moderation.filters.spam_filter.violator_role_id) && !msg.member.roles.has(serverDocument.config.moderation.filters.spam_filter.violator_role_id)) {
									violatorRoleID = serverDocument.config.moderation.filters.spam_filter.violator_role_id;
								}
								await this.bot.handleViolation(msg.guild, serverDocument, msg.channel, msg.member, userDocument, memberDocument, `You continued to spam in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `**@${this.bot.getName(msg.channel.guild, serverDocument, msg.member, true)}** continues to spam in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `Second-time spam violation in #${msg.channel.name} (${msg.channel})`, serverDocument.config.moderation.filters.spam_filter.action, violatorRoleID);
							}
							// Clear spamDocument, restarting the spam filter process
							spamDocument.remove();
						}
					}
					// Save spamDocument and serverDocument
					await serverDocument.save().catch(err => {
						winston.verbose(`Failed to save server data for spam filter..`, { svrid: msg.guild.id }, err);
					});
				}

				// Mention filter
				if (serverDocument.config.moderation.isEnabled && serverDocument.config.moderation.filters.mention_filter.isEnabled && !serverDocument.config.moderation.filters.mention_filter.disabled_channel_ids.includes(msg.channel.id) && memberBotAdminLevel < 1) {
					let totalMentions = msg.mentions.members ? msg.mentions.members.size() : msg.mentions.users.size() + msg.mentions.roles.size();
					if (serverDocument.config.moderation.filters.mention_filter.include_everyone && msg.mentions.everyone) totalMentions++;

					// Check if mention count is higher than threshold
					if (totalMentions > serverDocument.config.moderation.filters.mention_filter.mention_sensitivity) {
						winston.verbose(`Handling mention spam from member "${msg.author.tag}" in channel "${msg.channel.name}" on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });

						// Delete message if necessary
						if (serverDocument.config.moderation.filters.mention_filter.delete_message) {
							try {
								await msg.delete();
							} catch (err) {
								winston.verbose(`Failed to delete filtered mention spam message from member "${msg.author.tag}" in channel "${msg.channel.name}" on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
							}
						}

						// Get user data
						const findDocument = await this.db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
							winston.debug(`Failed to find or create user data for message mention filter violation`, { usrid: msg.author.id }, err);
						});
						const userDocument = findDocument.doc;
						if (userDocument) {
							// Handle this as a violation
							let violatorRoleID = null;
							if (!isNaN(serverDocument.config.moderation.filters.mention_filter.violator_role_id) && !msg.member.roles.has(serverDocument.config.moderation.filters.mention_filter.violator_role_id)) {
								violatorRoleID = serverDocument.config.moderation.filters.spam_filter.violator_role_id;
							}
							await this.bot.handleViolation(msg.guild, serverDocument, msg.channel, msg.member, userDocument, memberDocument, `You put ${totalMentions} mentions in a message in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `**@${this.bot.getName(msg.guild, serverDocument, msg.member, true)}** mentioned ${totalMentions} members / roles in a message in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `Mention spam (${totalMentions} members / roles) in #${msg.channel.name} (${msg.channel})`, serverDocument.config.moderation.filters.mention_filter.action, violatorRoleID);
						}
					}
				}

				// Only keep responding if the bot is on in the channel and author isn't blocked on the server
				if (channelDocument.bot_enabled && !serverDocument.config.blocked.includes(msg.author.id)) {
					// Translate message if necessary
					const translatedDocument = serverDocument.config.translated_messages.id(msg.author.id);
					if (translatedDocument) {
						// Detect the language (not always accurate; used only to exclude English messages from being translated to English)
						mstranslate.detect({ text: msg.cleanContent }, (err, res) => {
							if (err) {
								winston.verbose(`Failed to auto-detect language for message "${msg.cleanContent}" from member "${msg.author.tag}" on server "${msg.guild}"`, { svrid: msg.guild.id, usrid: msg.author.id }, err);
							} else if (res.toLowerCase() !== "en") {
								// If the message is not in English, attempt to translate it from the language defined for the user
								mstranslate.translate({ text: msg.cleanContent, from: translatedDocument.source_language, to: "EN" }, (translateErr, translateRes) => {
									if (err) {
										winston.verbose(`Failed to translate "${msg.cleanContent}" from member "${msg.author.tag}" on server "${msg.guild}"`, { svrid: msg.channel.guild.id, usrid: msg.author.id }, translateErr);
									} else {
										msg.channel.send({
											embed: {
												color: 0x3669FA,
												title: `**@${this.bot.getName(msg.channel.guild, serverDocument, msg.member)}** said:`,
												description: `\`\`\`${translateRes}\`\`\``,
												footer: {
													text: `Translated using Microsoft Translator. The translated text might not be accurate!`,
												},
											},
										});
									}
								});
							}
						});
					}

					// Vote by mention
					if (serverDocument.config.commands.points.isEnabled && msg.guild.members.size > 2 && !serverDocument.config.commands.points.disabled_channel_ids.includes(msg.channel.id) && msg.content.startsWith("<@") && msg.content.indexOf(">") < msg.content.indexOf(" ") && msg.content.includes(" ") && msg.content.indexOf(" ") < msg.content.length - 1) {
						const member = await this.bot.memberSearch(msg.content.split(" ")[0].trim(), msg.guild);
						const voteString = msg.content.split(" ").splice(1).join(" ");
						if (member && ![this.bot.user.id, msg.author.id].includes(member.id) && !member.user.bot) {
							// Get target user data
							const findDocument = await this.db.users.findOrCreate({ _id: member.id }).catch(err => {
								winston.verbose(`Failed to get user document for votes..`, err);
							});
							const targetUserDocument = findDocument.doc;
							if (targetUserDocument) {
								let voteAction;

								// Check for +1 triggers
								for (const voteTrigger of this.configJS.voteTriggers) {
									if (voteString.startsWith(voteTrigger)) {
										voteAction = "upvoted";

										// Increment points
										targetUserDocument.points++;
										break;
									}
								}

								// Check for gild triggers
								if (voteString.startsWith(" gild") || voteString.startsWith(" guild")) {
									voteAction = "gilded";
								}

								// Log and save changes if necessary
								if (voteAction) {
									const saveTargetUserDocument = async () => {
										try {
											await targetUserDocument.save();
										} catch (err) {
											winston.verbose(`Failed to save user data for points`, { usrid: member.id }, err);
										}
										winston.verbose(`User "${member.user.tag}" ${voteAction} by user "${msg.author.tag}" on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });
									};

									if (voteAction === "gilded") {
										// Get user data
										const findDocument2 = await this.db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
											winston.verbose(`Failed to get user document for gilding member...`, err);
										});
										const userDocument = findDocument2.doc;
										if (userDocument) {
											if (userDocument.points > 10) {
												userDocument.points -= 10;
												await userDocument.save().catch(err => {
													winston.verbose("Failed to save user data for points", { usrid: msg.author.id }, err);
												});
												targetUserDocument.points += 10;
												await saveTargetUserDocument();
											} else {
												winston.verbose(`User "${msg.author.tag}" does not have enough points to gild "${member.user.tag}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });
												msg.channel.send({
													embed: {
														color: 0xFF0000,
														description: `Hey ${msg.author}, you don't have enough GAwesomePoints to gild ${member}!`,
													},
												});
											}
										}
									} else {
										await saveTargetUserDocument();
									}
								}
							}
						}
					}

					// Vote based on previous message
					for (const voteTrigger of this.configJS.voteTriggers) {
						if (` ${msg.content}`.startsWith(voteTrigger)) {
							// Get previous message
							const fetchedMessages = await msg.channel.fetchMessages({ limit: 1, before: msg.id }).catch(err => {
								winston.verbose(`Failed to fetch message for voting...`, err);
							});
							const message = fetchedMessages.first();
							if (message && ![this.bot.user.id, msg.author.id].includes(message.author.id) && !message.author.bot) {
								// Get target user data
								const findDocument3 = await this.db.users.findOrCreate({ _id: message.author.id }).catch(err => {
									winston.verbose(`Failed to find user document for voting..`, err);
								});
								const targetUserDocument2 = findDocument3.doc;
								if (targetUserDocument2) {
									winston.verbose(`User "${message.author.tag}" upvoted by user "${msg.author.tag}" on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });

									// Increment points
									targetUserDocument2.points++;

									// Save changes to targetUserDocument2
									await targetUserDocument2.save().catch(err => {
										winston.verbose(`Failed to save user data for points`, { usrid: msg.author.id }, err);
									});
								}
							}
							break;
						}
					}

					// Check if message mentions AFK user (server and global)
					if (msg.mentions.members.size()) {
						msg.mentions.members.forEach(async member => {
							if (![this.bot.user.id, msg.author.id].includes(member.id) && !member.user.bot) {
								// Server AFK message
								const targetMemberDocument = serverDocument.members.id(member.id);
								if (targetMemberDocument && targetMemberDocument.afk_message) {
									msg.channel.send({
										embed: {
											thumbnail: {
												url: member.user.displayAvatarURL,
											},
											color: 0x3669FA,
											author: {
												name: `@${this.bot.getName(msg.guild, serverDocument, member)} is currently AFK.`,
											},
											description: `\`\`\`${targetMemberDocument.afk_message}\`\`\``,
										},
									});
								} else {
									// Global AFK message
									const targetUserDocument = await this.db.users.findOne({ _id: member.id }).exec().catch(err => {
										winston.verbose(`Failed to find user document for global AFK message >.>`, err);
									});
									if (targetUserDocument && targetUserDocument.afk_message) {
										msg.channel.send({
											embed: {
												thumbnail: {
													url: member.user.displayAvatarURL,
												},
												color: 0x3669FA,
												author: {
													name: `@${this.bot.getName(msg.guild, serverDocument, member)} is currently AFK.`,
												},
												description: `\`\`\`${targetUserDocument.afk_message}\`\`\``,
											},
										});
									}
								}
							}
						});
					}

					// Only keep responding if there isn't an ongoing command cooldown in the channel
					if (!channelDocument.isCommandCooldownOngoing || memberBotAdminLevel > 0) {
						// Check if message is a command, tag command, or extension trigger
						const commandObject = await this.bot.checkCommandTag(msg.content, serverDocument);

						if (commandObject && this.bot.getPublicCommandMetadata(commandObject.command)	&&
								serverDocument.config.commands[commandObject.command].isEnabled &&
								(this.bot.getPublicCommandMetadata(commandObject.command).adminExempt || memberBotAdminLevel >= serverDocument.config.commands[commandObject.command].admin_level) &&
								!serverDocument.config.commands[commandObject.command].disabled_channel_ids.includes(msg.channel.id)) {
							// Increment command usage count
							await this.incrementCommandUsage(serverDocument, commandObject.command);
							// Get User data
							const findDocument = await this.db.users.findOrCreate({ _id: msg.author.id }).catch(err => {
								winston.debug(`Failed to find or create user data for message`, { usrid: msg.author.id }, err);
							});
							const userDocument = findDocument.doc;
							if (userDocument) {
								// NSFW filter for command suffix
								if (memberBotAdminLevel < 1 && this.bot.getPublicCommandMetadata(commandObject.command).defaults.isNSFWFiltered && checkFiltered(serverDocument, msg.channel, commandObject.suffix, true, false)) {
									// Delete offending message if necessary
									if (serverDocument.config.moderation.filters.nsfw_filter.delete_message) {
										try {
											await msg.delete();
										} catch (err) {
											winston.verbose(`Failed to delete NSFW command message from member "${msg.author.tag}" in channel "${msg.channel.name}" on server "${msg.guild}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
										}
									}
									// Handle this as a violation
									let violatorRoleID = null;
									if (!isNaN(serverDocument.config.moderation.filters.nsfw_filter.violator_role_id) && !msg.member.roles.has(serverDocument.config.moderation.filters.nsfw_filter.violator_role_id)) {
										violatorRoleID = serverDocument.config.moderation.filters.nsfw_filter.violator_role_id;
									}
									await this.bot.handleViolation(msg.guild, serverDocument, msg.channel, msg.member, userDocument, memberDocument, `You tried to fetch NSFW content in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `**@${this.bot.getName(msg.guild, serverDocument, msg.member, true)}** tried to fetch NSFW content (\`${msg.cleanContent}\`) in #${msg.channel.name} (${msg.channel}) on ${msg.guild}`, `NSFW filter violation ("${msg.cleanContent}") in #${msg.channel.name} (${msg.channel})`, serverDocument.config.moderation.filters.nsfw_filter.action, violatorRoleID);
								} else {
									// Assume its a command, lets run it!
									winston.verbose(`Treating "${msg.cleanContent}" as a command`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });
									await this.deleteCommandMessage(serverDocument, channelDocument, msg);
									try {
										const botObject = {
											bot: this.bot,
											db: this.db,
											configJS: this.configJS,
											configJSON: this.configJSON,
											utils: Utils,
											Utils,
										};
										const documents = {
											serverDocument,
											channelDocument,
											memberDocument,
											userDocument,
										};
										const commandData = {
											name: commandObject.command,
											usage: this.bot.getPublicCommandMetadata(commandObject.command).usage,
											description: this.bot.getPublicCommandMetadata(commandObject.command).description,
										};
										await this.bot.getPublicCommand(commandObject.command)(botObject, documents, msg, commandObject.suffix, commandData);
									} catch (err) {
										winston.warn(`Failed to process command "${commandObject.command}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id }, err);
										msg.channel.send({
											embed: {
												color: 0xFF0000,
												title: `Something went wrong! 😱`,
												description: `**Error Message**: \`\`\`js\n${err.stack}\`\`\``,
												footer: {
													text: `You should report this on GitHub so we can fix it!`,
												},
											},
										});
									}
									await this.setCooldown(serverDocument, channelDocument);
								}
								await this.saveServerDocument(serverDocument);
							}
							// Check if it's a trigger for a tag command
						} else if (commandObject && serverDocument.config.tags.list.id(commandObject.command) && serverDocument.config.tags.list.id(commandObject.command).isCommand) {
							winston.verbose(`Treating "${msg.cleanContent}" as a tag command`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });
							msg.channel.send(`${serverDocument.config.tags.list.id(commandObject.command).content}`, {
								disableEveryone: true,
							});
							await Promise.all([this.setCooldown(serverDocument, channelDocument), this.saveServerDocument(serverDocument)]);
						} else {
							// Check if it's a command or keyword extension trigger
							let extensionApplied = false;
							for (let i = 0; i < serverDocument.extensions.length; i++) {
								if (memberBotAdminLevel >= serverDocument.extensions[i].admin_level && serverDocument.extensions[i].enabled_channel_ids.includes(msg.channel.id)) {
									// Command extensions
									if (serverDocument.extensions[i].type === "command" && commandObject && commandObject.command && commandObject.command === serverDocument.extensions[i].key) {
										winston.verbose(`Treating "${msg.cleanContent}" as a trigger for command extension "${serverDocument.extensions[i].name}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id, extid: serverDocument.extensions[i]._id });
										extensionApplied = true;

										// Do the normal things for commands
										await Promise.all([this.incrementCommandUsage(serverDocument, commandObject.command), this.deleteCommandMessage(serverDocument, channelDocument, msg), this.setCooldown(serverDocument, channelDocument)]);
										// TODO: runExtension(bot, db, msg.guild, serverDocument, msg.channel, serverDocument.extensions[i], msg, commandObject.suffix, null);
									} else if (serverDocument.extensions[i].type === "keyword") {
										const keywordMatch = msg.content.containsArray(serverDocument.extensions[i].keywords, serverDocument.extensions[i].case_sensitive);
										if (((serverDocument.extensions[i].keywords.length > 1 || serverDocument.extensions[i].keywords[0] !== "*") && keywordMatch.selectedKeyword > -1) || (serverDocument.extensions[i].keywords.length === 1 && serverDocument.extensions[i].keywords[0] === "*")) {
											winston.verbose(`Treating "${msg.cleanContent}" as a trigger for keyword extension "${serverDocument.extensions[i].name}"`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id, extid: serverDocument.extensions[i]._id });
											// TODO: runExtension(bot, db, msg.guild, serverDocument, msg.channel, serverDocument.extensions[i], msg, null, keywordMatch);
										}
									}
								}
							}

							if (extensionApplied) {
								await this.saveServerDocument(serverDocument);
							}

							// Check if it's a chatterbot prompt
							if (!extensionApplied && serverDocument.config.chatterbot && (msg.content.startsWith(`<@${this.bot.user.id}>`) || msg.content.startsWith(`<@!${this.bot.user.id}>`)) && msg.content.contains(" ") && msg.content.length > msg.content.indexOf(" ")) {
								const prompt = msg.content.split(" ")
									.splice(1)
									.join(" ")
									.trim();
								await Promise.all([this.setCooldown(serverDocument, channelDocument), this.saveServerDocument(serverDocument)]);
								// Default help response
								if (prompt.toLowerCase().startsWith("help")) {
									msg.channel.send({
										embed: {
											color: 0x3669FA,
											title: `Hey there, it seems like you are lost!`,
											description: `Use \`${await this.bot.getCommandPrefix(msg.guild, serverDocument)}help\` for info about how to use me on this server! 😄`,
										},
									});
									// Process chatterbot prompt
								} else {
									winston.verbose(`Treating "${msg.cleanContent}" as a chatterbot prompt`, { svrid: msg.guild.id, chid: msg.channel.id, usrid: msg.author.id });
									const m = await msg.channel.send({
										embed: {
											color: 0x3669FA,
											description: `The chatter bot is thinking...`,
										},
									});
									const response = await this.chatterPrompt(msg.author.id, msg.cleanContent).catch(err => {
										winston.verbose(`Failed to get chatter prompt.`, err);
										m.edit({
											embed: {
												color: 0xFF0000,
												description: `Failed to get an answer, ok?!`,
											},
										});
									});
									if (response) {
										await m.edit({
											embed: {
												title: `The Program-O Chatter Bot replied with:`,
												url: `https://program-o.com`,
												description: response,
												thumbnail: {
													url: `https://cdn.program-o.com/images/program-o-luv-bunny.png`,
												},
												color: 0x00FF00,
											},
										});
									}
								}
							} else if (!extensionApplied && msg.mentions.members.find(mention => mention.id === this.bot.user.id) && serverDocument.config.tag_reaction.isEnabled) {
								const random = serverDocument.config.tag_reaction.messages.random().replaceAll("@user", `**@${this.bot.getName(msg.guild, serverDocument, msg.member)}**`).replaceAll("@mention", `<@!${msg.author.id}>`);
								if (random) {
									msg.channel.send(random);
								} else {
									msg.channl.send({
										embed: {
											color: 0xFF0000,
											title: `Woops!`,
											description: `Failed to get a random tag to place in chat.. 😱`,
										},
									});
								}
							}
						}
					} else {
						await this.saveServerDocument(serverDocument);
					}
				}
			}
		}
	}

	/**
	 * Get a chatter bot response
	 * @param {User|GuildMember|Snowflake} userOrUserID 
	 * @param {?String} prompt 
	 * @returns {Promise} The response if successful, otherwise an error
	 */
	async chatterPrompt (userOrUserID, prompt) {
		let res;
		try {
			res = await rp.get({
				uri: `http://api.program-o.com/v2/chatbot/`,
				qs: {
					bot_id: 6,
					say: encodeURIComponent(prompt),
					convo_id: userOrUserID.id ? userOrUserID.id : userOrUserID,
					format: "json",
				},
				headers: {
					Accept: "application/json",
					"User-Agent": "GAwesomeBot (https://github.com/GilbertGobbels/GAwesomeBot)",
				},
			});
		} catch (err) {
			throw err;
		}
		let response;
		if (res.statusCode === 200 && res.body) {
			response = JSON.parse(res.body).botsay
				.replaceAll("Program-O", this.bot.user.username)
				.replaceAll("<br/>", "\n")
				.replaceAll("Elizabeth", "BitQuote");
		} else {
			response = "I don't feel like talking right now.. 😠";
		}
		return response;
	}

	/**
	 * Delete command message if necessary
	 * @param {Document} serverDocument 
	 * @param {Document} channelDocument 
	 * @param {Message} msg 
	 */
	async deleteCommandMessage (serverDocument, channelDocument, msg) {
		if (serverDocument.config.delete_command_messages && msg.channel.permissionsFor(msg.guild.me).has("MANAGE_MESSAGES")) {
			channelDocument.isMessageDeletedDisabled = true;
			try {
				await msg.delete();
			} catch (err) {
				winston.debug(`Failed to delete command message..`, err);
			}
			channelDocument.isMessageDeletedDisabled = false;
			await serverDocument.save();
		}
	}

	/**
	 * Set a command cooldown in a channel
	 * @param {Document} serverDocument 
	 * @param {Document} channelDocument 
	 */
	async setCooldown (serverDocument, channelDocument) {
		if (channelDocument.command_cooldown > 0 || serverDocument.config.command_cooldown > 0) {
			channelDocument.isCommandCooldownOngoing = true;
			// End cooldown after interval (favor channel config over server)
			this.bot.setTimeout(async () => {
				channelDocument.isCommandCooldownOngoing = false;
				await serverDocument.save().catch(err => {
					winston.debug(`Failed to save server data for command cooldown...`, { svrid: serverDocument._id }, err);
				});
			}, channelDocument.command_cooldown || serverDocument.config.command_cooldown);
		}
	}

	/**
	 * Increment command usage count
	 * @param {Document} serverDocument 
	 * @param {?String} command 
	 */
	async incrementCommandUsage (serverDocument, command) {
		if (!serverDocument.command_usage) {
			serverDocument.command_usage = {};
		}

		if (serverDocument.command_usage[command] === null) {
			serverDocument.command_usage[command] = 0;
		}

		serverDocument.command_usage[command]++;
		serverDocument.markModified("command_usage");
	}

	/**
	 * Save any and all changes to the serverDocument
	 * @param {Document} serverDocument 
	 */
	async saveServerDocument (serverDocument) {
		try {
			await serverDocument.save();
		} catch (err) {
			winston.debug(`Failed to save server data for message create...`, { svrid: serverDocument._id }, err);
		}
	}
}

module.exports = MessageCreate;
