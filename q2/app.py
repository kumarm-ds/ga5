from flask import Flask, request, jsonify

app = Flask(__name__)


def calculate_charge(old_price, new_price, days_remaining, days_in_actual_month, spec):
    """
    Compute the prorated charge for a mid-cycle plan upgrade.

    spec == "v1": legacy rule, always divides by a fixed 30-day month.
    spec == "v2": corrected rule, divides by the actual number of days
                  in the billing month (handles Feb, leap years, 31-day months).
    """
    diff = new_price - old_price

    if spec == "v1":
        divisor = 30
    elif spec == "v2":
        divisor = days_in_actual_month
    else:
        raise ValueError("spec must be 'v1' or 'v2'")

    if divisor == 0:
        raise ValueError("divisor cannot be 0")

    return diff * (days_remaining / divisor)


@app.route("/prorate", methods=["POST"])
def prorate():
    try:
        data = request.get_json(force=True)

        old_price = data["old_price"]
        new_price = data["new_price"]
        days_remaining = data["days_remaining"]
        days_in_actual_month = data["days_in_actual_month"]
        spec = data["spec"]

        charge = calculate_charge(
            old_price, new_price, days_remaining, days_in_actual_month, spec
        )

        return jsonify({"charge": charge}), 200

    except KeyError as e:
        return jsonify({"error": f"Missing field: {e}"}), 400
    except (ValueError, TypeError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {e}"}), 500


# Simple health check — useful to "wake up" free-tier hosts before grading
@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


if __name__ == "__main__":
    # host="0.0.0.0" so it's reachable from outside your own machine
    app.run(host="0.0.0.0", port=5000)
