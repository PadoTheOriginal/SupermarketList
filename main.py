from flask import Flask, render_template, request, jsonify
import pickle
import os

app = Flask("SupermaketList", template_folder="./content",
            static_folder="./content")
supermarket_list = []
version = 0
users = []
multiple_users_interval = False


@app.route("/")
def index():
    global version
    interval_delay = 2000 if multiple_users_interval else 10000

    total = sum([item["Total"] for item in supermarket_list])
    total_formatted = 'R${:,.2f}'.format(total)

    return render_template("index.jinja2",
                           supermarket_list=supermarket_list,
                           total_formatted=total_formatted,
                           total=total,
                           version=version,
                           interval_delay=interval_delay)


@app.route('/NewItem/', methods=['POST'])
def new_item():
    global version

    supermarket_item = {}
    supermarket_item["Name"] = request.form["Name"]
    supermarket_item["Quantity"] = int(request.form["Quantity"])
    supermarket_item["Price"] = float(request.form['Price'])
    supermarket_item["Total"] = supermarket_item["Quantity"] * \
        supermarket_item["Price"]
    supermarket_item["TotalFormat"] = 'R${:,.2f}'.format(
        supermarket_item["Total"])

    supermarket_list.append(supermarket_item)

    pickle.dump(supermarket_list, open('supermarket_list.pickle', "wb"))
    version += 1
    total = sum([item["Total"] for item in supermarket_list])
    total_formatted = 'R${:,.2f}'.format(total)

    return jsonify(success=True, version=version, supermarket_item=supermarket_item, total_formatted=total_formatted)


@app.route('/ChangeItem/', methods=['POST'])
def change_item():
    global version

    index = int(request.form["Index"]) - 1

    supermarket_list[index]["Name"] = request.form["Name"]
    supermarket_list[index]["Quantity"] = int(request.form["Quantity"])
    supermarket_list[index]["Price"] = float(request.form['Price'])
    supermarket_list[index]["Total"] = supermarket_list[index]["Quantity"] * \
        supermarket_list[index]["Price"]
    supermarket_list[index]["TotalFormat"] = 'R${:,.2f}'.format(
        supermarket_list[index]["Total"])

    pickle.dump(supermarket_list, open('supermarket_list.pickle', "wb"))
    version += 1
    total = sum([item["Total"] for item in supermarket_list])
    total_formatted = 'R${:,.2f}'.format(total)

    return jsonify(success=True, supermarket_item=supermarket_list[index], total_formatted=total_formatted, version=version)


@app.route('/RemoveItem/', methods=['POST'])
def remove_item():
    global version

    index = int(request.form["Index"]) - 1

    del supermarket_list[index]

    pickle.dump(supermarket_list, open('supermarket_list.pickle', "wb"))
    version += 1

    return jsonify(success=True)


@app.after_request
def add_header(r):
    r.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    r.headers["Pragma"] = "no-cache"
    r.headers["Expires"] = "0"
    r.headers['Cache-Control'] = 'public, max-age=0'
    return r


@app.route("/GetVersion/", methods=['GET'])
def get_version():
    global multiple_users_interval
    global version

    if (request.environ['REMOTE_ADDR'] in users):
        users.remove(request.environ['REMOTE_ADDR'])

    users.append(request.environ['REMOTE_ADDR'])

    if len(users) > 1 and not multiple_users_interval:
        multiple_users_interval = True
        version += 1

    return jsonify(success=True, version=version)


if __name__ == "__main__":
    if os.path.exists("supermarket_list.pickle"):
        supermarket_list = pickle.load(open('supermarket_list.pickle', "rb"))

    app.run('0.0.0.0', 80, debug=True, use_reloader=True)
