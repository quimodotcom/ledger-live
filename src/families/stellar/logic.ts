import { BigNumber } from "bignumber.js";
import StellarSdk, { ServerApi } from "stellar-sdk";
import type { CacheRes } from "../../cache";
import { makeLRUCache } from "../../cache";
import type { Account, Operation, OperationType } from "../../types";
import { fetchSigners, fetchBaseFee, loadAccount } from "./api";
import { getCryptoCurrencyById, parseCurrencyUnit } from "../../currencies";
import { encodeOperationId } from "../../operation";
import { getReservedBalance } from "./getReservedBalance";
import { getBalanceId } from "./getBalanceId";

const currency = getCryptoCurrencyById("stellar");

const getMinimumBalance = (account: ServerApi.AccountRecord): BigNumber => {
  return parseCurrencyUnit(
    currency.units[0],
    getReservedBalance(account).toString()
  );
};

export const getAccountSpendableBalance = async (
  balance: BigNumber,
  account: ServerApi.AccountRecord
): Promise<BigNumber> => {
  const minimumBalance = getMinimumBalance(account);
  const { recommendedFee } = await fetchBaseFee();
  return BigNumber.max(balance.minus(minimumBalance).minus(recommendedFee), 0);
};

export const getOperationType = (
  operation: ServerApi.OperationRecord,
  addr: string
): OperationType => {
  switch (operation.type) {
    case "create_account":
      return operation.funder === addr ? "OUT" : "IN";

    case "payment":
      if (operation.from === addr && operation.to !== addr) {
        return "OUT";
      }

      return "IN";

    case "path_payment_strict_send":
      return "OUT";

    case "path_payment_strict_receive":
      return "IN";

    case "change_trust":
      if (new BigNumber(operation.limit).eq(0)) {
        return "OPT_OUT";
      }

      return "OPT_IN";

    default:
      if (operation.source_account === addr) {
        return "OUT";
      }

      return "IN";
  }
};

const getRecipients = (operation): string[] => {
  switch (operation.type) {
    case "create_account":
      return [operation.account];

    case "payment":
      return [operation.to_muxed || operation.to];

    default:
      return [];
  }
};

export const formatOperation = async (
  rawOperation: ServerApi.OperationRecord,
  accountId: string,
  addr: string
): Promise<Operation> => {
  const transaction = await rawOperation.transaction();
  const type = getOperationType(rawOperation, addr);
  const value = getValue(rawOperation, transaction, type);
  const recipients = getRecipients(rawOperation);
  const memo = transaction.memo
    ? transaction.memo_type === "hash" || transaction.memo_type === "return"
      ? Buffer.from(transaction.memo, "base64").toString("hex")
      : transaction.memo
    : null;
  const operation = {
    id: encodeOperationId(accountId, rawOperation.transaction_hash, type),
    accountId,
    fee: new BigNumber(transaction.fee_charged),
    value,
    type: type,
    hash: rawOperation.transaction_hash,
    blockHeight: transaction.ledger_attr,
    date: new Date(rawOperation.created_at),
    senders: [rawOperation.source_account],
    recipients,
    transactionSequenceNumber: Number(transaction.source_account_sequence),
    // @ts-expect-error check transaction_successful property
    hasFailed: !rawOperation.transaction_successful,
    blockHash: null,
    extra: {
      pagingToken: rawOperation.paging_token,
      // @ts-expect-error check transaction_successful property
      assetCode: rawOperation?.asset_code,
      // @ts-expect-error check transaction_successful property
      assetIssuer: rawOperation?.asset_issuer,
      memo,
    },
  };
  return operation;
};

const getValue = (
  operation: ServerApi.OperationRecord,
  transaction: ServerApi.TransactionRecord,
  type: OperationType
): BigNumber => {
  let value = new BigNumber(0);

  // @ts-expect-error check transaction_successful property
  if (!operation.transaction_successful) {
    return type === "IN" ? value : new BigNumber(transaction.fee_charged || 0);
  }

  switch (operation.type) {
    case "create_account":
      value = parseCurrencyUnit(currency.units[0], operation.starting_balance);

      if (type === "OUT") {
        value = value.plus(transaction.fee_charged);
      }

      return value;

    case "payment":
    case "path_payment_strict_send":
    case "path_payment_strict_receive":
      return parseCurrencyUnit(currency.units[0], operation.amount);

    default:
      return type !== "IN" ? new BigNumber(transaction.fee_charged) : value;
  }
};

export const isMemoValid = (memoType: string, memoValue: string): boolean => {
  switch (memoType) {
    case "MEMO_TEXT":
      if (memoValue.length > 28) {
        return false;
      }

      break;

    case "MEMO_ID":
      if (new BigNumber(memoValue.toString()).isNaN()) {
        return false;
      }

      break;

    case "MEMO_HASH":
    case "MEMO_RETURN":
      if (!memoValue.length || memoValue.length !== 64) {
        return false;
      }

      break;
  }

  return true;
};

export const isAccountMultiSign = async (
  account: Account
): Promise<boolean> => {
  const signers = await fetchSigners(account);
  return signers.length > 1;
};

/**
 * Returns true if address is valid, false if it's invalid (can't parse or wrong checksum)
 *
 * @param {*} address
 */
export const isAddressValid = (address: string): boolean => {
  if (!address) return false;

  try {
    return (
      StellarSdk.StrKey.isValidEd25519PublicKey(address) ||
      StellarSdk.StrKey.isValidMed25519PublicKey(address)
    );
  } catch (err) {
    return false;
  }
};

export const getRecipientAccount: CacheRes<
  Array<{
    account: Account;
    recipient: string;
  }>,
  {
    id: string | null;
    isMuxedAccount: boolean;
    assetIds: string[];
  } | null
> = makeLRUCache(
  async ({ recipient }) => await recipientAccount(recipient),
  (extract) => extract.recipient,
  {
    max: 300,
    maxAge: 5 * 60,
  } // 5 minutes
);

export const recipientAccount = async (
  address?: string
): Promise<{
  id: string | null;
  isMuxedAccount: boolean;
  assetIds: string[];
} | null> => {
  if (!address) {
    return null;
  }

  let accountAddress = address;

  const isMuxedAccount = Boolean(
    StellarSdk.StrKey.isValidMed25519PublicKey(address)
  );

  if (isMuxedAccount) {
    const muxedAccount = new StellarSdk.MuxedAccount.fromAddress(address, "0");
    accountAddress = muxedAccount.baseAccount().accountId();
  }

  const account = await loadAccount(accountAddress);

  if (!account) {
    return null;
  }

  return {
    id: account.id,
    isMuxedAccount,
    assetIds: account.balances.reduce((allAssets, balance) => {
      return [...allAssets, getBalanceId(balance)];
    }, []),
  };
};

export const rawOperationsToOperations = async (
  operations: ServerApi.OperationRecord[],
  addr: string,
  accountId: string
): Promise<Operation[]> => {
  const supportedOperationTypes = [
    "create_account",
    "payment",
    "path_payment_strict_send",
    "path_payment_strict_receive",
    "change_trust",
  ];

  return Promise.all(
    operations
      .filter((operation) => {
        return (
          // @ts-expect-error check from property
          operation.from === addr ||
          // @ts-expect-error check to property
          operation.to === addr ||
          // @ts-expect-error check funder property
          operation.funder === addr ||
          // @ts-expect-error check account property
          operation.account === addr ||
          // @ts-expect-error check account property
          operation.trustor === addr ||
          operation.source_account === addr
        );
      })
      .filter((operation) => supportedOperationTypes.includes(operation.type))
      .map((operation) => formatOperation(operation, accountId, addr))
  );
};
