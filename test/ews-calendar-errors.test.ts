import { describe, expect, it } from "vitest";
import { ewsFailure } from "../src/providers/m365/ews-errors.js";

describe("ewsFailure", () => {
  it("finds an error response message nested anywhere in the reply", () => {
    const reply = {
      Envelope: {
        Body: {
          UpdateItemResponse: {
            ResponseMessages: {
              UpdateItemResponseMessage: [
                {
                  "@_ResponseClass": "Error",
                  ResponseCode: "ErrorChangeKeyRequiredForWriteOperations",
                  MessageText: "ChangeKey is required for this operation.",
                },
              ],
            },
          },
        },
      },
    };
    expect(ewsFailure(reply)).toEqual({
      code: "ErrorChangeKeyRequiredForWriteOperations",
      message: "ChangeKey is required for this operation.",
    });
  });

  it("returns nothing for a successful reply", () => {
    expect(
      ewsFailure({
        Envelope: { Body: { X: { "@_ResponseClass": "Success", ResponseCode: "NoError" } } },
      }),
    ).toBeUndefined();
  });
});
