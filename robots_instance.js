import { Game, State, Goal, RobotMove, TimeoutMode } from './robots.js';
import { Point, intdiv, isAnyOf, arrayFind } from './util.js';
import { Worker } from "worker_threads";

class Client {
	constructor(key) {
		this.playerId = null;
		this.socket = null;
		this.key = key;
	}
}

export class RobotsGameInstance {
	constructor() {
		this.game = new Game();
		this.clients = new Map();
		this.moveSequence = [];
		this.redoStack = [];

		this.currentTimerId = null;

		this.solutionWorker = new Worker("./solutionWorker.js");
		this.demoSequence = null;
		this.readyNextRound = false;

		this.solutionWorker = null;
	}

	initializeGame(params) {
		this.game.resetGame(4, Math.random() * 2000000000);
		this.game.startWaitState();
		this.currentTimerId = setTimeout(() => this.startRound(), Math.floor(this.game.revealTimeout * 1000));

		//ToDo: When game resets after winner, need to call workOnSolution
		this.workOnSolution();
	}
	
	onSocketConnect(clientKey, ws) {
		let client = this.clients.get(clientKey);
		
		if (client === undefined) {
			client = new Client(clientKey);
			this.clients.set(clientKey, client);
		}
		
		if (client.socket != null) {
			console.log(`Rejecting client ${clientKey}`);
			ws.send(`REJECT_CLIENT Client already connected`);
			ws.close();
			return;
		}
		
		client.socket = ws;

		ws.on('message', (message) => {
			console.log(`Player = ${clientKey} : Message = ${message}`);
			this.onMessage(client, message.toString());
		});
	
		ws.on('close', () => {
			console.log(`${clientKey} closed the connection.`);
			client.socket = null;
		});
		
		this.syncGame(client);
	}
	
	onMessage(clientKey, message) {
		let lines = message.split('\n');
		if (lines.length <= 0) {
			return;
		}
		
		for (let i = 0; i < lines.length; ++i) {
			let [command, ...args] = lines[i].split(' ');
			command = command.toUpperCase();
			this.doCommand(clientKey, command, args);
		}
	}
	
	sendAll(message) {
		this.sendAllExcept(message, null);
	}
	
	sendAllExcept(message, exceptFor) {
		for (const [clientKey, client] of this.clients) {
			console.log(`ClientKey = ${clientKey}`);
			if (clientKey != exceptFor) {
				if (client !== undefined && client.socket != null) {
					client.socket.send(message);
				}
			}
		}
	}
	
	makeGameStateCommand() {
		let command = `SET_STATE ${this.game.state}`;
		if (this.game.currentGoal != null && this.game.state !== State.Wait) {
			command += ` ${this.game.currentGoal.toInt()}`;
		} else {
			command += ` -1`
		}
	
		return command;
	}
	
	makeStartTimerCommand() {
		return `START_TIMER ${this.game.timerStartTime}`;
	}
	
	makeBoardCommand() {
		let command = `NEW_BOARD ${this.game.robots.length} ${this.game.seed}`;
		if (this.game.tokensToWin != null) {
			command += ` ${this.game.tokensToWin}`;
		}
		return command;
	}
	
	makePlayerVoteCommand(player) {
		return `PLAYER_VOTE ${player.id} ${player.vote}`;
	}

	syncGame(client) {
		let commands = [];
		commands.push(this.makeBoardCommand());
		
		for (let player of this.game.getPlayers()) {
			commands.push(this.makePlayerJoinedCommand(player.id, player.name));
			if (player.tokens.length > 0) {
				commands.push(this.makeGivePlayerTokensCommand(player.id, ...player.tokens));
			}
			if (player.vote != null) {
				commands.push(this.makePlayerVoteCommand(player));
			}
		}
		
		if (client.playerId != null) {
			commands.push(this.makeAssignPlayerCommand(client.playerId));
		}
		
		for (let i = 0; i < this.game.playerBids.length; ++i) {
			commands.push(this.makePlayerBidCommand(this.game.playerBids[i].playerId));
		}
	
		commands.push(this.makeGameStateCommand(this.game.state));
	
		if(this.demoSequence && isAnyOf(this.game.state, State.Solve, State.Free, State.End)) {
			commands.push(this.makeDemoReadyCommand());
		}
	
		if (this.game.state == State.Bid) {
			if (this.game.timerStartTime != null) {
				commands.push(this.makeStartTimerCommand());
			}
		} else if (this.game.state == State.Solve) {
			if (this.game.timerStartTime != null) {
				commands.push(this.makeStartSolveCommand());
			}
		}
	
		if (this.game.originalRobotConfig != null) {
			commands.push(this.makeRobotResetCommand());
		}
		
		if (isAnyOf(this.game.state, State.Solve)) {
			commands.push(this.makeRobotSequenceCommand(this.moveSequence));
		} else {
			commands.push(this.makeRobotMoveAllCommand());
		}
	
		client.socket.send(commands.join('\n'));
	}
	
	makePlayerJoinedCommand(playerId, playerName) {
		return `PLAYER_JOINED ${playerId} ${playerName}`;
	}
	
	makeGivePlayerTokensCommand(playerId, ...tokens) {
		let command = `GIVE_TOKENS ${playerId}`;
		for (let i = 0; i < tokens.length; ++i) {
			command += ` ${tokens[i].toInt()}`;
		}
		return command;
	}
	
	makePlayerBidCommand(playerId) {
		let playerBid = this.game.getBid(playerId);
		if (playerBid == null) {
			`PLAYER_BID ${playerId} 0 0`;
		}
		return `PLAYER_BID ${playerId} ${playerBid.amount} ${playerBid.timestamp}`;
	}
	
	makeRobotAllCommand(command, positions) {
		for (let i = 0; i < positions.length; ++i) {
			command += ` ${positions[i].x} ${positions[i].y}`;
		}
		if (this.game.state == State.Solve) {
			command += ` ${this.moveSequence.length}`;
		}
		return command;
	}
	
	makeRobotResetCommand() {
		let command = 'ROBOT_RESET';
		if (this.game.originalRobotConfig == null) {
			this.game.autoResetRobots();
		}
		return this.makeRobotAllCommand(command, this.game.originalRobotConfig);
	}
	
	makeRobotMoveAllCommand() {
		return this.makeRobotAllCommand('ROBOT_MOVEALL', this.game.getRobotPositions());
	}
	
	makeRobotSequenceCommand(sequence, isDemo = false) {
		let command = isDemo ? 'DEMO_SEQUENCE' : 'ROBOT_SEQUENCE';
	
		for (let i = 0; i < sequence.length; ++i) {
			command += ` ${sequence[i].color} ${sequence[i].direction}`;
		}
	
		return command;
	}
	
	makeRobotMoveCommand(robotId, moves = null) {
		let pos = this.game.robots[robotId];
		if (moves == null || moves.length == 0) {
			moves = [pos];
		}
		
		let command = `ROBOT_MOVE ${robotId}`;
	
		// Always pass the move sequence ID, even if it's not meaningful
		if (this.game.state == State.Solve) {
			command += ` ${this.moveSequence.length}`;
		} else {
			command += ' 0';
		}
	
		for (let i = 0; i < moves.length; ++i) {
			command += ` ${moves[i].x} ${moves[i].y}`;
		}
	
		return command;
	}
	
	makeAssignPlayerCommand(playerId) {
		let player = this.game.getPlayer(playerId);
		return `ASSIGN_PLAYER ${player.id} ${player.name}`;
	}
	
	makeTimeSyncCommand(origTime, serverTime) {
		return `TIME_SYNC ${origTime} ${serverTime}`;
	}
	
	clearTimer() {
		if (this.currentTimerId != null) {
			clearTimeout(this.currentTimerId);
			this.currentTimerId = null;
		}
	}
	
	endBidState() {
		console.log('Ending bidding state');
		this.clearTimer();
		this.game.startSolveState();
	
		if (this.demoSequence != null) {
			this.sendAll(this.makeDemoReadyCommand());
		}
	
		this.updateSolveState();
	}
	
	advanceSolveState() {
		console.log('Advancing solve state');
		this.clearTimer();
		this.game.advanceSolveState();
		this.updateSolveState();
	}
	
	makeStartSolveCommand() {
		return `START_SOLVE ${this.game.getSolvingPlayer()} ${this.game.timerStartTime}`;
	}
	
	makeDemoReadyCommand() {
		return `DEMO_READY`;
	}

	makeDemoAlertCommand() {
		return `DEMO_ALERT`;
	}

	makeRobotFinalPositionCommand() {
		let str = 'FINAL_POSITION'
	
		for(let i in this.game.robots) {
			str += ` ${this.game.robots[i].x} ${this.game.robots[i].y}`;
		}
	
		return str;
	}
	
	updateSolveState() {
		if (this.game.state == State.Solve) {
			this.moveSequence = [];
			this.redoStack = [];
			let commands = [this.makeGameStateCommand(State.Solve), this.makeRobotResetCommand(), this.makeStartSolveCommand()]
			this.sendAll(commands.join('\n'));
			this.currentTimerId = setTimeout(() => this.advanceSolveState(), Math.floor(this.game.solveTimeout * 1000));
		} else {
			let commands = [this.makeGameStateCommand(State.Free)];
			if (this.game.nextRoundTimeoutMode == TimeoutMode.Auto) {
				this.startNextRoundTimer();
				commands.push(this.makeStartTimerCommand());
			}
			this.sendAll(commands.join('\n'));
		}
	}
	
	checkVoteState(players, state) {
		let votes = this.game.collectVotes();
		if (votes.size <= 0) {
			return null;
		}
		
		let stateVoteSort = (lhs, rhs) => {
			if (lhs[1] == rhs[1]) {
				let lhsStateIdx = Game.stateOptionIndex(state, lhs[0]);
				let rhsStateIdx = Game.stateOptionIndex(state, rhs[0]);
				return lhsStateIdx - rhsStateIdx;
			}
			return lhs[1] - rhs[1];
		}
	
		let numVotes = Array.from(votes.values()).reduce((a, b) => a + b, 0);
		let numPlayers = players.length;
		let sortedVotes = Array.from(votes.entries()).sort(stateVoteSort).reverse();
		let remainingVotes = numPlayers - numVotes;
		
		let secondMostVotes = 0;
		if (sortedVotes.length > 1) {
			secondMostVotes = sortedVotes[1][1];
		}
	
		// Never advance if there is a wait vote pending
		if (votes.has('WAIT')) {
			return null;
		}
		
		// These bids require consensus (or at least all people to have voted)
		if (Game.isConsensusVote(sortedVotes[0][0])) {
			if (remainingVotes == 0) {
				return sortedVotes[0][0];
			} else {
				return null;
			}
		}
		
		if (secondMostVotes + remainingVotes >= numVotes && remainingVotes > 0) {
			return null;
		}
		
		return sortedVotes[0][0];
	}
	
	nextRound() {
		this.game.startWaitState();
	
		this.clearTimer();
		this.endSolution();
		this.workOnSolution();
		this.readyNextRound = false;

		this.currentTimerId = setTimeout(() => this.startRound(), Math.floor(this.game.revealTimeout * 1000));
		let commands = [this.makeGameStateCommand(this.game.state), this.makeRobotResetCommand(), this.makeStartTimerCommand()];
		this.sendAll(commands.join('\n'));
	}

	startRound() {
		this.game.startBidState();

		let command = this.makeGameStateCommand(this.game.state);
		this.sendAll(command);

		this.clearTimer();
	}
	
	startNextRoundTimer() {
		this.clearTimer();
		this.game.timerStartTime = Date.now() + this.game.serverTimeOffset;
		this.currentTimerId = setTimeout(() => this.nextRoundTimeout(), this.game.nextRoundTimeout * 1000.0);
		this.readyNextRound = false;
	}
	
	nextRoundTimeout() {
		let votes = this.game.collectVotes();
		if (votes.get('WAIT') === undefined) {
			this.nextRound();
		} else {
			this.readyNextRound = true;
		}
	}
	
	startDemo(clientKey) {
		let cachedRobotPositions = this.game.getRobotPositions();
		this.game.resetRobotPositions();
	
		// run through the entire solution to get the final robot positions
		// to send to the client so the arrows can look nice
		for(let i in this.demoSequence) {
			let robotID = this.demoSequence[i].color;
			let dir = this.demoSequence[i].direction;
			this.game.moveRobot(robotID, dir);
		}
	
		let commands = [this.makeRobotFinalPositionCommand(), this.makeRobotSequenceCommand(this.demoSequence, true)];
	
		this.game.setRobotPositions(cachedRobotPositions);
	
		let client = this.clients.get(clientKey);
		client.socket.send(commands.join('\n'));
	}
	
	executeVote(vote) {
		console.log(`Majority has voted ${vote}`);
		
		if (!Game.isVoteAllowedInState(this.game.state, vote)) {
			console.log(`Error: vote ${vote} not allowed in state ${this.game.state}`);
			return false;
		}
		
		if (vote == 'SKIPBID') {
			this.endBidState();
		} else if (isAnyOf(vote, 'NEXT')) {
			this.nextRound();
		}
	}
	
	clearVotes() {
		this.game.clearVotes();
	}

	dropPlayer(playerId) {
		this.clients.forEach((client, key) => {
			if (client.playerId == playerId) {
				client.playerId = null;
				this.game.removePlayer(playerId);
			
				if (this.game.state == State.Solve && this.game.getSolvingPlayer() == playerId) {
					// TODO: concat these commands with the player leaving command
					this.advanceSolveState();
				}
			
				this.sendAll(`PLAYER_LEFT ${playerId}`);
			}
		})
	}
	
	doCommand(client, command, args) {
		if (command == 'SYNC_TIME') {
			// Use a constant time offset to ensure we are actually synchronizing
			client.socket.send(this.makeTimeSyncCommand(args[0], Date.now() + this.game.serverTimeOffset));
		} else if (command == 'JOIN_GAME') {
			let desiredName = this.game.makeValidName(args[0]);
			client.playerId = this.game.addPlayer(desiredName, null);
			client.cachedName = this.game.getPlayer(client.playerId).name;
			
			let playerJoinedCommand = this.makePlayerJoinedCommand(client.playerId, client.cachedName);
			let commands = [playerJoinedCommand, this.makeAssignPlayerCommand(client.playerId)];
	
			client.socket.send(commands.join('\n'));
			
			this.sendAllExcept(playerJoinedCommand, client.key);
		} else if (command == 'LEAVE_GAME') {
			dropPlayer(client.playerId);
		} else if (command == 'PLAYER_RENAME') {
			let playerId = parseInt(args[0]);
			let newName = this.game.renamePlayer(playerId, this.game.makeValidName(args[1]));
			this.sendAll(`PLAYER_RENAME ${playerId} ${newName}`);
		} else if (command == 'MAKE_BID') {
			if (client.playerId != null && this.game.getState() == State.Bid) {
				let player = this.game.getPlayer(client.playerId);
				if (!this.game.allowMultipleBids && player.bidAmount != null) {
					return;
				}
	
				let bidAmount = parseInt(args[0]);
				let isFirstBid = this.game.timerStartTime == null;
				this.game.setBid(client.playerId, bidAmount);
				
				let commands = [this.makePlayerBidCommand(client.playerId)];
	
				if (isFirstBid) {
					commands.push(this.makeStartTimerCommand());
					this.currentTimerId = setTimeout(() => this.endBidState(), Math.floor(this.game.bidTimeout * 1000));
				}
	
				if (!this.game.allowMultipleBids) {
					player.vote = 'SKIPBID';
					commands.push(this.makePlayerVoteCommand(player))
				}
				
				this.sendAll(commands.join('\n'));
	
				// TODO: figure out a way to concat this with the previous commands
				// Also TODO: don't send the timer data if this is triggered on the first bid
				let voteComplete = this.checkVoteState(this.game.getPlayers(), this.game.state);
				if (voteComplete != null) {
					this.executeVote(voteComplete);
				}
			}
		} else if (command == 'FREE_MOVE_ROBOT') {
			if (isAnyOf(this.game.state, State.Free, State.End)) {
				let robotId = parseInt(args[0]);
				let pos = new Point(parseInt(args[1]), parseInt(args[2]));
				let cell = this.game.board.getCell(pos);
				if (cell != null && !cell.fullyFenced() && cell.bumper == null) {
					this.game.robots[robotId] = pos;
					let commands = [this.makeRobotMoveCommand(robotId)];
					this.sendAll(commands.join('\n'));
				} else {
					client.socket.send(this.makeRobotMoveCommand(robotId))
				}
			}
		} else if (command == 'MOVE_ROBOT') {
			if (client.playerId != null && this.game.playerAllowedMove(client.playerId)) {
				let robotId = parseInt(args[0]);
				let direction = parseInt(args[1]);
				let isFree = isAnyOf(this.game.state, State.Free, State.End);
				
				if (!isFree) {
					this.moveSequence.push(new RobotMove(this.game.robots[robotId], direction, robotId));
				}
				let outMoves = []
				let originalRobotPosition = this.game.robots[robotId];
				let result = this.game.moveRobot(robotId, direction, outMoves);
				if (!originalRobotPosition.equals(result)) {
					let commands = [this.makeRobotMoveCommand(robotId, outMoves.slice(1))];
				
					if (this.game.state == State.Solve && this.game.getSolvingPlayer() == client.playerId) {
						let currentBid = this.game.playerBids[this.game.currentSolveBid];
						
						if (this.moveSequence.length <= currentBid.amount && this.game.checkSolveSolution()) {
							this.clearTimer();
							commands.push(this.makeGivePlayerTokensCommand(client.playerId, this.game.currentGoal));
							commands.push(this.makeGameStateCommand(this.game.state));

							if(this.demoSequence != null && this.moveSequence.length > this.demoSequence.length) {
								commands.push(this.makeDemoAlertCommand());
							}
						}
					}
		
					this.sendAll(commands.join('\n'));
				} else {
					client.socket.send(this.makeRobotMoveCommand(robotId))
				}
			}
		} else if (command == 'REDO_ROBOT') {
			if (client.playerId != null && this.game.getState() == State.Solve && this.game.playerAllowedMove(client.playerId) && this.redoStack.length > 0) {
				let addMove = this.redoStack.pop();
				let outMoves = [];
				this.game.moveRobot(addMove.color, addMove.direction, outMoves);
				this.moveSequence.push(addMove);
				this.sendAll(this.makeRobotMoveCommand(addMove.color, outMoves.slice(1)));
			}
		} else if (command == 'UNDO_ROBOT') {
			if (client.playerId != null && this.game.getState() == State.Solve && this.game.playerAllowedMove(client.playerId) && this.moveSequence.length > 0) {
				let lastMove = this.moveSequence.pop();
				this.game.robots[lastMove.color] = lastMove.position;
				this.redoStack.push(lastMove);
				this.sendAll(this.makeRobotMoveCommand(lastMove.color));
			}
		} else if (command == 'RESET_ROBOTS') {
			if (client.playerId != null && this.game.playerAllowedMove(client.playerId)) {
				this.game.resetRobotPositions();
				if (this.game.getSolvingPlayer() == client.playerId) {
					this.redoStack.push(...this.moveSequence.reverse());
					this.moveSequence = [];
				}
				let command = this.makeRobotMoveAllCommand();
				this.sendAllExcept(command, client.key);
			}
		} else if (command == 'SKIP_SOLVE') {
			if (this.game.state == State.Solve && client.playerId == this.game.getSolvingPlayer()) {
				this.advanceSolveState();
			}
		} else if (command == 'VOTE') {
			let player = this.game.getPlayer(client.playerId);
			let isValidVote = Game.isVoteAllowedInState(this.game.state, args[0]);
			if (isValidVote) {
				player.vote = args[0];
				let votes = this.game.collectVotes();
				let commands = [this.makePlayerVoteCommand(player)];
	
				if (this.game.state == State.Free) {
					if (this.game.timerStartTime != null && this.readyNextRound) {
						if (votes.get('WAIT') === undefined) {
							this.nextRound();
						}
					} else if (this.game.timerStartTime == null && isAnyOf(this.game.nextRoundTimeoutMode, TimeoutMode.FirstVote, TimeoutMode.Majority)) {
						let numPlayers = this.game.getNumPlayers();
						let voteThreshold = this.game.nextRoundTimeoutMode == TimeoutMode.FirstVote ? 1 : intdiv(numPlayers + 1, 2);
	
						if (votes.get('NEXT') >= voteThreshold) {
							this.startNextRoundTimer();
							commands.push(this.makeStartTimerCommand());
						}
					}
				}
	
				if (commands.length > 0) {
					this.sendAll(commands.join('\n'));
				}
	
				let majorityVote = this.checkVoteState(this.game.getPlayers(), this.game.state);
				if (majorityVote != null) {
					this.executeVote(majorityVote);
				}
			}
		} else if (command == 'VIEW_DEMO') {
			if (this.demoSequence != null) {
				this.startDemo(client.key);
			}
		}
	}
	
	endSolution() {
		this.demoSequence = null;
	}
	
	workerMessageListener(gameInstance, msg) {
		let solutionGoal = new Goal(msg.goalColor, msg.goalSymbol);
		let solutionRobots = [];
	
		for(let i in msg.robots) {
			solutionRobots[i] = new Point(msg.robots[i].x, msg.robots[i].y);
		}
	
		if(!gameInstance.isSolutionStale(msg.seed, solutionGoal, solutionRobots)) {
			gameInstance.demoSequence = msg.solution;
			if (isAnyOf(gameInstance.game.state, State.Solve, State.Free, State.End)) {
				gameInstance.sendAll(gameInstance.makeDemoReadyCommand());
			}
		}
	}
	
	workOnSolution() {
		if (this.solutionWorker != null) {
			this.solutionWorker.terminate();
		}
		this.demoSequence = null;
		this.solutionWorker = new Worker("./solutionWorker.js");
		this.solutionWorker.on("message", (msg) => this.workerMessageListener(this, msg))
		
		let msg = {
			'boardSeed': this.game.seed,
			'boardString': this.game.board.toString(),
			'boardWidth': this.game.board.width,
			'boardHeight': this.game.board.height,
			'goalColor': this.game.currentGoal.color,
			'goalSymbol': this.game.currentGoal.symbol,
			'robots': this.game.robots
		}
	
		this.solutionWorker.postMessage(msg);
	}
	
	isSolutionStale(seed, goal, robots) {
		let stale = false;
	
		if (seed != this.game.seed) {
			stale = true;
		}
	
		if (!goal.equals(this.game.currentGoal)) {
			stale = true;
		}
	
		for(let i in robots) {
			if (!robots[i].equals(this.game.originalRobotConfig[i])) {
				stale = true;
			}
		}
	
		return stale;
	}
}