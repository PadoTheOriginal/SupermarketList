from flask import Flask, render_template, request, jsonify
import pickle, os

app = Flask("SupermaketList", template_folder="./content", static_folder="./content")
supermarket_list = []
version = 0


@app.route("/")
def index():
    total = 'R${:,.2f}'.format(sum([item["Total"] for item in supermarket_list]))

    return render_template("index.html", supermarket_list=supermarket_list, total=total, version=version)


@app.route("/GetVersion/", methods=['GET'])
def get_version():
    return jsonify(success=True, version=version)


@app.route('/NewItem/', methods=['POST'])
def new_item():
    global version

    supermarket_item = {}
    supermarket_item["Name"] = request.form["Name"]
    supermarket_item["Quantity"] = int(request.form["Quantity"])
    supermarket_item["Price"] = float(request.form['Price'])
    supermarket_item["Total"] = supermarket_item["Quantity"] * supermarket_item["Price"]
    supermarket_item["TotalFormat"] = 'R${:,.2f}'.format(supermarket_item["Total"])

    supermarket_list.append(supermarket_item)

    pickle.dump(supermarket_list, open('supermarket_list.pickle', "wb"))
    version += 1

    return jsonify(success=True)


@app.route('/ChangeItem/', methods=['POST'])
def change_item():
    global version

    index = int(request.form["Index"]) - 1

    supermarket_list[index]["Name"] = request.form["Name"]
    supermarket_list[index]["Quantity"] = int(request.form["Quantity"])
    supermarket_list[index]["Price"] = float(request.form['Price'])
    supermarket_list[index]["Total"] = supermarket_list[index]["Quantity"] * supermarket_list[index]["Price"]
    supermarket_list[index]["TotalFormat"] = 'R${:,.2f}'.format(supermarket_list[index]["Total"])

    pickle.dump(supermarket_list, open('supermarket_list.pickle', "wb"))
    version += 1

    return jsonify(success=True)


if __name__ == "__main__":
    if os.path.exists("supermarket_list.pickle"):
        supermarket_list = pickle.load(open('supermarket_list.pickle', "rb"))

    app.run('0.0.0.0', 80, debug=False, use_reloader=True)
