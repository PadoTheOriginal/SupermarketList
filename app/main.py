from flask import Flask, render_template, request, jsonify, make_response, session, redirect
from flask_httpauth import HTTPBasicAuth
import bcrypt
import models
import os

# default user is 'admin@admin' and password is 'admin'

app = Flask("SupermaketList", template_folder="./app/content",
            static_folder="./app/content")

basicAuth = HTTPBasicAuth()

version = 0
users = models.User.GetUsers()
multiple_users_interval = False

@basicAuth.verify_password
def verify_password(username, password):
    global multiple_users_interval
    global version
    
    user: models.User = next((user for user in users if user.Username == username), None)
    
    if user and bcrypt.checkpw(password.encode('utf-8'), user.PasswordHash.encode('utf-8')):
        user.Online = True
        
        if len([user for user in users if user.Online]) > 1 and not multiple_users_interval:
            multiple_users_interval = True
            version += 1
        
        return username
    
@app.route('/login', methods=['POST'])
def login_post():
        
    user: models.User = next((user for user in users if user.Username == request.form['username']), None)

    if user and bcrypt.checkpw(request.form['password'].encode('utf-8'), user.PasswordHash.encode('utf-8')):
        request.authorization = {'username': request.form['username'], 'password': request.form['password']}
        session['logged_in'] = True
    
    return redirect('/')
    
@app.route('/login', methods=['GET'])
def login_get():
    return """
            <form action="/login" method="POST">
            <input type="username" name="username" placeholder="Username">
            <input type="text" name="password" placeholder="Password">
            <input type="submit" value="Log in">
            </form>
        """

@app.route("/")
@basicAuth.login_required
def index():
    global version
    interval_delay = 2000 if multiple_users_interval else 10000
    
    app.logger.info(str(request.authorization))
    
    current_user:models.User = models.User.GetUser(request.authorization.username, True)

    response = make_response(render_template("index.jinja2",
                           current_user=current_user,
                           version=version,
                           interval_delay=interval_delay))
    response.set_cookie('home', expires=0)
    return response


@app.route('/NewItem/', methods=['POST'])
@basicAuth.login_required
def new_item():
    global version

    supermarketItem = models.SupermarketItem(
        0,
        request.form["Name"],
        int(request.form["Quantity"]),
        float(request.form['Price']),
        int(request.form["SupermarketListId"])
    ).InsertSupermarketItem()

    total_formatted = models.SupermarketList.GetSupermarketListTotalFormatted(supermarketItem.SupermarketListId)

    version += 1

        


@app.route('/ChangeItem/', methods=['POST'])
@basicAuth.login_required
def change_item():
    global version

    supermarketItem = models.SupermarketItem(
        int(request.form["SupermarketItemId"]),
        request.form["Name"],
        int(request.form["Quantity"]),
        float(request.form['Price']),
        int(request.form["SupermarketListId"])
    ).UpdateSupermarketItem()

    version += 1
    
    total_formatted = models.SupermarketList.GetSupermarketListTotalFormatted(supermarketItem.SupermarketListId)

    return jsonify(success=True, supermarket_item=supermarketItem.ToDict(), total_formatted=total_formatted, version=version)


@app.route('/RemoveItem/', methods=['POST'])
@basicAuth.login_required
def remove_item():
    global version

    models.SupermarketItem.DeleteSupermarketItem(int(request.form["SupermarketItemId"]))
    
    version += 1

    total_formatted = models.SupermarketList.GetSupermarketListTotalFormatted(int(request.form["SupermarketListId"]))

    return jsonify(success=True, version=version, total_formatted=total_formatted)


@app.after_request
def add_header(r):
    r.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    r.headers["Pragma"] = "no-cache"
    r.headers["Expires"] = "0"
    r.headers['Cache-Control'] = 'public, max-age=0'
    return r


@app.route("/GetVersion/", methods=['GET'])
@basicAuth.login_required
def get_version():
    return jsonify(success=True, version=version)


if __name__ == "__main__":
    app.secret_key = os.urandom(19)
    
    if os.path.exists('./certificates'):
        app.run('0.0.0.0', 443, debug=True, use_reloader=True, ssl_context=('./certificates/cert.pem', './certificates/key.pem'))

    else:
        app.run('0.0.0.0', 80, debug=True, use_reloader=True, ssl_context=('./certificates/cert.pem', './certificates/key.pem'))
        