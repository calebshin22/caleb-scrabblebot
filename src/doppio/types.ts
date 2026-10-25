// Adapted from mm-nair/ScrabbleBot (teammate's bot "Doppio"), src/types.ts.
// Upstream pieces are MIT-licensed (Clockwork Labs); see that repo.

export type Rack = readonly number[];

export type AuctionType = "Vickrey" | "FirstPrice";

export type TournamentPhase = "practice" | "swiss" | "elimination" | "finals";

export interface ParticipantObservation {
  botId: string;
  balance: number;
  score: number;
  rackSize: number;
  knownLetters: Rack;
  simulatedStrategy?: string;
}

export interface AuctionObservation {
  auctionId: string;
  letter: string;
  winnerBotId: string | null;
  paid: number;
  myBid?: number;
}

export interface WordObservation {
  botId: string;
  word: string;
  totalReward: number;
}

export interface DecisionContext {
  matchId: string;
  auctionId: string;
  letter: string;
  myBotId: string;
  myRack: Rack;
  myBalance: number;
  myScore: number;
  remainingAuctions: number;
  startingRackSize: number;
  auctionType: AuctionType;
  phase: TournamentPhase;
  opponents: readonly ParticipantObservation[];
  auctionHistory: readonly AuctionObservation[];
  wordHistory: readonly WordObservation[];
  initialRack?: Rack;
}

export interface BotStrategy {
  name: string;
  decideBid(context: DecisionContext): number;
  chooseWord(context: DecisionContext): string | null;
}
